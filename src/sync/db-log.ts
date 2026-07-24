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

/** Must be called at worker exit so a --once process can terminate (open pool keeps it alive). */
export async function closeDb(): Promise<void> {
  if (pool) { try { await pool.end(); } catch { /* ignore */ } pool = null; }
}
