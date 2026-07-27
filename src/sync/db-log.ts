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

export async function logEvent(ev: SyncEvent): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `insert into sync_events(run_id, worker, direction, entity_type, entity_id, action, status, side, message, detail, dedupe_key)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (dedupe_key) do nothing`,
      [ev.runId ?? null, ev.worker, ev.direction ?? null, ev.entityType ?? null, ev.entityId ?? null,
       ev.action ?? null, ev.status, ev.side ?? null, ev.message ?? null,
       ev.detail != null ? JSON.stringify(ev.detail) : null, ev.dedupeKey ?? null]);
  } catch (e) { console.warn(`[db-log] logEvent: ${(e as Error).message}`); }
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

/** Must be called at worker exit so a --once process can terminate (open pool keeps it alive). */
export async function closeDb(): Promise<void> {
  if (pool) { try { await pool.end(); } catch { /* ignore */ } pool = null; }
}
