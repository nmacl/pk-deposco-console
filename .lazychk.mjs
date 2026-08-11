// Has the lazy item-create path actually run? createMissingItem logs only to the console, so the
// DB won't show it directly — infer from the Deposco item count vs what we deliberately loaded.
// Read-only.
import 'dotenv/config';
import pg from 'pg';
import { getDeposcoToken } from './dist/deposco.js';
import { loadDeposcoConfig } from './dist/sync/config.js';
import { authReq } from './dist/sync/bc-client.js';

const cfg = loadDeposcoConfig();
const t = await getDeposcoToken(cfg);

// 1. what the DB knows (expect nothing item-related — that's the point)
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
const ev = await pool.query(
  `select worker, action, entity_type, status, count(*)::int n from sync_events
    where entity_type='item' or action like '%item%' or message ilike '%lazy%' or message ilike '%created item%'
    group by worker, action, entity_type, status`);
console.log(`[db] item-related sync_events rows: ${ev.rows.length}`);
for (const r of ev.rows) console.log(`   ${r.worker} ${r.action} ${r.entity_type} ${r.status} ${r.n}`);
if (!ev.rows.length) console.log('   (none — lazy creates are console-only, so this is expected)');

// 2. count items in Deposco and compare to what we loaded on purpose
let count = 0, maxId = 0;
let url = `${cfg.apiBase}/items`;
let params = { size: 200 };
for (let p = 0; p < 40; p++) {
  let d;
  try { d = await authReq('get', url, t, { params }); } catch (e) { console.log(`[deposco] paging stopped: HTTP ${e.response?.status ?? '?'}`); break; }
  for (const r of d.data ?? []) { count++; const id = r.self?.id ?? 0; if (id > maxId) maxId = id; }
  if (d.complete) break;
  const next = d.links?.find((l) => l.rel === 'next')?.href;
  if (!next) break;
  url = next; params = undefined;
}
console.log(`\n[deposco] items present: ${count}  (highest id ${maxId})`);
console.log(`[deposco] deliberately loaded: 3449 catalog + 10 first seed + 5 smoke-test = 3464 expected`);
const extra = count - 3464;
console.log(`[deposco] difference: ${extra > 0 ? '+' + extra : extra}`);
console.log(extra > 0
  ? `   => ${extra} item(s) beyond the deliberate loads — consistent with the lazy-create path having run`
  : `   => no surplus items; the lazy-create path has not created anything`);
await pool.end();
