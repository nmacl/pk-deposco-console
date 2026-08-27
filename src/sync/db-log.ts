/**
 * Structured sync logging to Supabase/Postgres (see db/logging-schema.sql). Workers emit an
 * explicit status per item at the point they know the outcome — so the "list of failures" is
 * `select … where status='fail'`, not log-string parsing. Idempotent via dedupe_key so a
 * re-run (or overlapping scheduled + manual tick) can't create duplicate rows.
 *
 * Entirely OPTIONAL: with no DATABASE_URL set, every function no-ops so workers run unchanged.
 * Never throws — a logging failure must never break a sync.
 */
import pg from 'pg';

const { Pool } = pg;
let pool: pg.Pool | null = null;
let disabled = false;

function getPool(): pg.Pool | null {
  if (disabled) return null;
  const url = process.env.DATABASE_URL;
  if (!url) { disabled = true; return null; }
  if (!pool) {
    pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 10_000 });
    pool.on('error', () => { /* swallow idle-client errors */ });
  }
  return pool;
}

export async function startRun(worker: string, trigger = 'manual'): Promise<number | null> {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query('insert into sync_runs(worker, trigger) values($1,$2) returning id', [worker, trigger]);
    return r.rows[0].id as number;
  } catch (e) { console.warn(`[db-log] startRun: ${(e as Error).message}`); return null; }
}

export async function finishRun(id: number | null, status: string, counts: Record<string, number>, note?: string): Promise<void> {
  const p = getPool();
  if (!p || id == null) return;
  try {
    await p.query('update sync_runs set finished_at=now(), status=$2, counts=$3, note=$4 where id=$1',
      [id, status, JSON.stringify(counts), note ?? null]);
  } catch (e) { console.warn(`[db-log] finishRun: ${(e as Error).message}`); }
}

export interface SyncEvent {
  runId?: number | null;
  worker: string;
  direction?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  status: 'ok' | 'skip' | 'floor' | 'desync' | 'fail';
  side?: 'bc' | 'deposco';
  message?: string;
  detail?: unknown;
  dedupeKey?: string;
}

// A repeat of an already-logged event (same dedupe_key) bumps `hits` and `last_ts` on the existing
// row instead of inserting: the row keeps its first-seen `ts`, and "how often / how recently" is a
// column, not a count(*). Those two columns were added 2026-08-27 (see the schema file); if the
// migration hasn't been applied yet we fall back to the original insert-or-ignore so logging keeps
// working and say so once.
let legacyEvents = false;
const MISSING_COL = /column "?(hits|last_ts)"? .*does not exist/i;

export async function logEvent(ev: SyncEvent): Promise<void> {
  const p = getPool();
  if (!p) return;
  const params = [ev.runId ?? null, ev.worker, ev.direction ?? null, ev.entityType ?? null, ev.entityId ?? null,
    ev.action ?? null, ev.status, ev.side ?? null, ev.message ?? null,
    ev.detail != null ? JSON.stringify(ev.detail) : null, ev.dedupeKey ?? null];
  const cols = 'run_id, worker, direction, entity_type, entity_id, action, status, side, message, detail, dedupe_key';
  const vals = '$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11';
  try {
    if (!legacyEvents) {
      await p.query(
        `insert into sync_events(${cols}) values(${vals})
         on conflict (dedupe_key) do update set hits = sync_events.hits + 1, last_ts = now()`, params);
      return;
    }
  } catch (e) {
    if (!MISSING_COL.test((e as Error).message)) { console.warn(`[db-log] logEvent: ${(e as Error).message}`); return; }
    legacyEvents = true;
    console.warn('[db-log] sync_events has no hits/last_ts columns — apply the 2026-08-27 migration in db/logging-schema.sql. Falling back to insert-or-ignore.');
  }
  try {
    await p.query(`insert into sync_events(${cols}) values(${vals}) on conflict (dedupe_key) do nothing`, params);
  } catch (e) { console.warn(`[db-log] logEvent: ${(e as Error).message}`); }
}

/**
 * Entities that have been failing for more than a day — the ones a watermark must be allowed to
 * move past (see pullFromShipments).
 *
 * A watermark that holds back to its oldest failure is correct for a TRANSIENT fault: the work
 * is reconsidered next tick and the mark catches up. For a PERMANENT one it is the old bug in
 * slow motion — the mark parks on that entity's stamp and "everything since" grows without
 * bound, which is exactly how the shipment sweep reached 2424 shipments a tick.
 *
 * `dailyDedupe` collapses a repeated failure to one row per entity per day per distinct message,
 * so the number of DISTINCT DAYS an entity appears is a good "still broken" signal and a bad
 * one for a blip. Two days means it survived a full cycle of retries.
 *
 * Returns an empty set when there is no DB — callers then behave exactly as before.
 */
export async function chronicFailures(
  worker: string,
  action: string,
  opts: { lookbackDays?: number; minDays?: number } = {},
): Promise<Set<string>> {
  const p = getPool();
  if (!p) return new Set();
  const lookback = opts.lookbackDays ?? 7;
  const minDays = opts.minDays ?? 2;
  try {
    const r = await p.query(
      `select entity_id, count(distinct (ts at time zone 'UTC')::date) as days
         from sync_events
        where worker = $1 and action = $2 and status = 'fail'
          and entity_id is not null
          and ts > now() - ($3 || ' days')::interval
        group by entity_id
       having count(distinct (ts at time zone 'UTC')::date) >= $4`,
      [worker, action, String(lookback), minDays]);
    return new Set(r.rows.map((row) => row.entity_id as string));
  } catch (e) { console.warn(`[db-log] chronicFailures: ${(e as Error).message}`); return new Set(); }
}

/**
 * When each entity last FAILED at this worker/action — the "last attempt" a chronic retry is
 * paced against. Uses last_ts (bumped on every deduped repeat) and falls back to ts if the
 * migration isn't applied. Only failures count: a success removes the entity from the chronic
 * set by itself, so it never needs pacing.
 */
export async function lastAttempts(worker: string, action: string, lookbackDays = 7): Promise<Map<string, Date>> {
  const p = getPool();
  if (!p) return new Map();
  const run = (expr: string) => p.query(
    `select entity_id, max(${expr}) as last
       from sync_events
      where worker = $1 and action = $2 and status = 'fail' and entity_id is not null
        and ts > now() - ($3 || ' days')::interval
      group by entity_id`,
    [worker, action, String(lookbackDays)]);
  try {
    let r;
    try { r = await run('coalesce(last_ts, ts)'); }
    catch (e) { if (!MISSING_COL.test((e as Error).message)) throw e; r = await run('ts'); }
    return new Map(r.rows.map((row) => [row.entity_id as string, new Date(row.last as string)]));
  } catch (e) { console.warn(`[db-log] lastAttempts: ${(e as Error).message}`); return new Map(); }
}

/**
 * Should a chronic entity be retried this tick? Deliberately dumb: a chronic failure is one BC
 * has rejected for 2+ days, and what fixes it (a receipt landing, a PO vouched, a dimension
 * combination unblocked) usually never touches the order itself — so there is no change stamp to
 * watch. Instead: retry every `intervalMs` (hourly by default), or straight away if someone asked
 * for a flush more recently than the last attempt (console "Retry chronic now"). Never attempted
 * → due.
 */
export function chronicDue(args: { lastAttempt: Date | null; flushAt: Date | null; now: Date; intervalMs: number }): boolean {
  const { lastAttempt, flushAt, now, intervalMs } = args;
  if (!lastAttempt || Number.isNaN(lastAttempt.getTime())) return true;
  if (flushAt && !Number.isNaN(flushAt.getTime()) && flushAt.getTime() > lastAttempt.getTime()) return true;
  return now.getTime() - lastAttempt.getTime() >= intervalMs;
}

// ── Cursors (sync_cursors) ─────────────────────────────────────────────────
// High-water marks live in the DB so they survive Railway restarts / redeploys (the old
// .inv-state.json file is ephemeral there). Returns null when no DB or no row yet.
export async function readCursor(worker: string, key = ''): Promise<string | null> {
  const p = getPool();
  if (!p) return null;
  try {
    const r = await p.query('select last_synced from sync_cursors where worker=$1 and key=$2', [worker, key]);
    return r.rows[0]?.last_synced ?? null;
  } catch (e) { console.warn(`[db-log] readCursor: ${(e as Error).message}`); return null; }
}

export async function writeCursor(worker: string, key: string, value: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `insert into sync_cursors(worker,key,last_synced,updated_at) values($1,$2,$3,now())
       on conflict (worker,key) do update set last_synced=excluded.last_synced, updated_at=now()`,
      [worker, key, value]);
  } catch (e) { console.warn(`[db-log] writeCursor: ${(e as Error).message}`); }
}

/** True when a DB is configured (so callers can prefer the DB cursor over the file). */
export function hasDb(): boolean { return !!process.env.DATABASE_URL; }

/** Small stable hash for building dedupe_keys from message content (anti-spam). */
export function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Strip the per-request noise out of an error message before it is hashed into a dedupe key.
 * Every BC error carries `CorrelationId: <guid>` and the bmi URLs carry record GUIDs — both are
 * different on every attempt, which is why dailyDedupe never actually deduped a BC failure
 * (WSOD305290: 124 rows, 124 distinct keys, one day). Only the KEY is normalised; the message
 * that lands in the row is untouched so the CorrelationId is still there for a BC support ticket.
 */
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export function normalizeForDedupe(message: string): string {
  return message
    .replace(/CorrelationId:\s*[0-9a-f-]+\.?/gi, '')
    .replace(GUID, '<guid>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dedupe key that collapses a recurring failure to one row per day per distinct message —
 *  verbose enough to see it, not spammy enough to bury the failures list. */
export function dailyDedupe(worker: string, entityId: string, message: string): string {
  return `${worker}:${entityId}:${new Date().toISOString().slice(0, 10)}:${hashKey(normalizeForDedupe(message))}`;
}

/** Must be called at worker exit so a --once process can terminate (open pool keeps it alive). */
export async function closeDb(): Promise<void> {
  if (pool) { try { await pool.end(); } catch { /* ignore */ } pool = null; }
}
