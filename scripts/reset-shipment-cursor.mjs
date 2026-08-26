#!/usr/bin/env node
/**
 * Reset the `co` worker's shipment watermarks (sync_cursors: co/shipments + co/shipments-updated).
 *
 * The sweep re-examines every shipment newer than these two marks. They are meant to track the
 * front of the queue; when they stop advancing the sweep silently grows without bound. On
 * 2026-08-26 both were found frozen at 2026-08-14 — #598 and 2026-08-14T11:26:53-05:00 — which
 * made 2424 of 2970 shipments due on EVERY tick and stretched a tick to ~55 minutes.
 *
 * The code no longer freezes them like that (see pullFromShipments), but a mark that is already
 * far behind still has to be brought forward once, or the first sweep after the fix inherits the
 * whole backlog. That is what this is for. It is a deliberate manual step, not something a worker
 * does to itself.
 *
 * IMPORTANT: everything OLDER than the window you set stops being swept. Run
 * `scripts/reconcile-shipments.mjs` first and clear any real drift, or you will strand it.
 *
 *   node scripts/reset-shipment-cursor.mjs                 # show current values, change nothing
 *   node scripts/reset-shipment-cursor.mjs --hours 48      # preview a 48h window
 *   node scripts/reset-shipment-cursor.mjs --hours 48 --apply
 */
import 'dotenv/config';
import pg from 'pg';
import { loadDeposcoConfig } from '../dist/sync/config.js';
import { getDeposcoToken } from '../dist/deposco.js';
import { fetchOutboundShipments } from '../dist/sync/orders.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const hi = argv.indexOf('--hours');
const HOURS = hi >= 0 ? Number(argv[hi + 1]) : null;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
const show = async (label) => {
  const r = await pool.query("select key, last_synced, updated_at from sync_cursors where worker='co' and key like 'shipments%' order by key");
  console.log(`${label}:`);
  for (const row of r.rows) console.log(`  co/${row.key} = ${row.last_synced}   (written ${row.updated_at.toISOString()})`);
};
await show('CURRENT');

if (HOURS === null) { console.log('\nPass --hours N to preview a new window.'); await pool.end(); process.exit(0); }

// Derive the number mark from the live list rather than guessing: the lowest shipment NUMBER
// touched inside the window. Anything newer than that is genuinely still in play.
console.log(`\nreading Deposco shipments to find the #${HOURS}h boundary…`);
const cfg = loadDeposcoConfig();
const shipments = await fetchOutboundShipments(cfg, await getDeposcoToken(cfg));
const cutoffMs = Date.now() - HOURS * 3600_000;
const inWindow = shipments.filter((s) => s.updatedDate && new Date(s.updatedDate).getTime() >= cutoffMs);
if (inWindow.length === 0) { console.error('no shipments in that window — refusing to guess'); await pool.end(); process.exit(1); }
const lowestNo = Math.min(...inWindow.map((s) => s.number));
// Match Deposco's own stamp format; the worker compares these as strings.
const oldestStamp = inWindow.map((s) => s.updatedDate).reduce((m, d) => (d < m ? d : m));

console.log(`\nPROPOSED (covers ${inWindow.length} shipment(s) touched in the last ${HOURS}h):`);
console.log(`  co/shipments         = ${lowestNo - 1}`);
console.log(`  co/shipments-updated = ${oldestStamp}`);
console.log(`\nShipments older than this will NO LONGER be swept. Confirm reconcile-shipments.mjs is clean first.`);

if (!APPLY) { console.log('\n(dry run — re-run with --apply to write)'); await pool.end(); process.exit(0); }

await pool.query("update sync_cursors set last_synced=$1, updated_at=now() where worker='co' and key='shipments'", [String(lowestNo - 1)]);
await pool.query("update sync_cursors set last_synced=$1, updated_at=now() where worker='co' and key='shipments-updated'", [oldestStamp]);
await show('\nAPPLIED');
await pool.end();
