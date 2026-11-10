/**
 * One-off: reverse the non-adjustment records the inventory pull posted to BC on 2026-11-09/10.
 *
 * From Deposco adjustment id 4124 (2026-11-09 12:45 CT) the inventoryAdjustments feed began
 * carrying every inventory-ledger movement — MOV (bin moves), SHP (shipments), REC (receipts) —
 * alongside the real manual adjustments (MAD), and the API labels all of them "Adjustment". The
 * pull posted each one to BC as a Positive Adjmt. (DEP<id>). This posts the opposite quantity for
 * every one of those that is NOT a MAD.
 *
 *   node scripts/reverse-nov9-junk.mjs <lines.csv>                      dry run (default)
 *   node scripts/reverse-nov9-junk.mjs <lines.csv> --apply              POST to BC
 *   node scripts/reverse-nov9-junk.mjs <lines.csv> --apply --limit 5
 *   node scripts/reverse-nov9-junk.mjs <lines.csv> --apply --posting-date 2026-11-10
 *
 * Input: CSV with header containing deposco_adjustment_id, bc_item_no, variant_code, location,
 * reversal_qty (one row per original DEP<id> posting, MAD rows already excluded).
 *
 * One reversal per original entry, externalAdjustmentId REV<id> → BC document no. DEPREV<id>, so
 * finance can tie DEP4124 to DEPREV4124. Safe to re-run: the AL codeunit refuses an
 * externalAdjustmentId it has already posted, and that refusal is counted as done.
 *
 * The codeunit floors decrements at BC on-hand. A clamped or floored reversal is reported, not
 * retried — it means BC no longer holds the stock at that location and needs a human look.
 */
import 'dotenv/config';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { loadBcConfig } from '../dist/sync/config.js';
import { getBcToken } from '../dist/auth.js';
import { postBcAdjustment, companyIdFor } from '../dist/sync/inventory.js';

const file = process.argv[2];
if (!file || file.startsWith('--')) { console.error('usage: node scripts/reverse-nov9-junk.mjs <lines.csv> [--apply] [--limit N] [--posting-date YYYY-MM-DD]'); process.exit(1); }
const APPLY = process.argv.includes('--apply');
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const LIMIT = parseInt(arg('--limit') ?? '0', 10);
const POSTING_DATE = arg('--posting-date');
const LOG = new URL('./reverse-nov9-junk.log.jsonl', import.meta.url);
const PROBLEMS = new URL('./reverse-nov9-junk.problems.csv', import.meta.url);

const [head, ...body] = readFileSync(file, 'utf8').trim().split('\n');
const cols = head.split(',');
const col = (name) => { const i = cols.indexOf(name); if (i < 0) throw new Error(`missing column ${name}`); return i; };
const [iId, iItem, iVar, iLoc, iQty] = ['deposco_adjustment_id', 'bc_item_no', 'variant_code', 'location', 'reversal_qty'].map(col);
let rows = body.map((l) => l.split(',')).map((r) => ({ id: r[iId], itemNo: r[iItem], variantCode: r[iVar], locationCode: r[iLoc], quantity: Number(r[iQty]) }));

// Every reversal undoes a positive posting; anything else means the input is wrong — stop.
const bad = rows.filter((r) => !/^\d+$/.test(r.id) || !(r.quantity < 0) || !r.itemNo || !r.locationCode);
if (bad.length) { console.error(`${bad.length} row(s) are not a negative reversal of a numeric id, e.g. ${JSON.stringify(bad[0])} — aborting`); process.exit(1); }
if (LIMIT > 0) rows = rows.slice(0, LIMIT);

console.log(`${rows.length} reversal(s), ${rows.reduce((s, r) => s + r.quantity, 0)} units${POSTING_DATE ? `, posting date ${POSTING_DATE}` : ', posting date = BC work date'} — ${APPLY ? 'APPLYING' : 'dry run'}`);
if (!APPLY) { for (const r of rows.slice(0, 5)) console.log(`  DEPREV${r.id} ${r.itemNo}/${r.variantCode} @${r.locationCode} ${r.quantity}`); console.log('  … re-run with --apply to post'); process.exit(0); }

const cfg = loadBcConfig();
let token = await getBcToken(cfg);
const companyId = await companyIdFor(cfg, token);
let ok = 0, already = 0, clamped = 0, failed = 0;
const problems = [];
for (const [n, r] of rows.entries()) {
  if (n % 200 === 199) token = await getBcToken(cfg); // long run — keep the token fresh
  let out;
  try {
    const res = await postBcAdjustment(cfg, companyId, token, { itemNo: r.itemNo, variantCode: r.variantCode, locationCode: r.locationCode, quantity: r.quantity, externalAdjustmentId: `REV${r.id}`, postingDate: POSTING_DATE });
    if (res.errorMessage) { clamped++; out = { status: 'clamped', posted: res.postedQuantity ?? 0, note: res.errorMessage }; }
    else { ok++; out = { status: 'ok', posted: res.postedQuantity, ile: res.itemLedgerEntryNo }; }
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/already been posted/i.test(msg)) { already++; out = { status: 'already' }; }
    else {
      // Keep BC's own sentence (reservation, insufficient quantity, blocked item …) — that is what
      // ops acts on. The CorrelationId is noise and differs per call, so it is stripped.
      const bc = /"message":"((?:[^"\\]|\\.)*)"/.exec(msg)?.[1] ?? msg;
      failed++; out = { status: 'fail', error: bc.replace(/\s*CorrelationId:.*$/, '').trim(), raw: msg.slice(0, 600) };
    }
  }
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...r, ...out }) + '\n');
  if (out.status === 'clamped' || out.status === 'fail') {
    const why = out.note ?? out.error;
    problems.push({ ...r, status: out.status, posted: out.posted ?? 0, why });
    console.log(`  DEPREV${r.id} ${r.itemNo}/${r.variantCode} ${r.quantity}: ${out.status} — ${why}`);
  }
  if (n % 100 === 99) console.log(`  ${n + 1}/${rows.length} — ok ${ok}, already ${already}, clamped ${clamped}, failed ${failed}`);
}
console.log(`done — ok ${ok}, already posted ${already}, clamped/floored ${clamped}, failed ${failed}. Log: scripts/reverse-nov9-junk.log.jsonl`);
if (problems.length) {
  // One row per reversal that did not fully post, plus a count per distinct reason (item numbers
  // and quantities blanked so "insufficient quantity of Item X" groups into one line).
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  writeFileSync(PROBLEMS, ['deposco_adjustment_id,bc_item_no,variant_code,location,reversal_qty,qty_actually_posted,status,reason',
    ...problems.map((p) => [p.id, p.itemNo, p.variantCode, p.locationCode, p.quantity, p.posted, p.status, q(p.why)].join(','))].join('\n') + '\n');
  const byWhy = new Map();
  for (const p of problems) { const k = `${p.status}: ${p.why.replace(/\d[\d.,-]*/g, '#')}`; byWhy.set(k, (byWhy.get(k) ?? 0) + 1); }
  console.log(`\n${problems.length} reversal(s) did not fully post — scripts/reverse-nov9-junk.problems.csv`);
  for (const [k, c] of [...byWhy].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(5)}  ${k}`);
}
if (clamped || failed) process.exitCode = 1;
