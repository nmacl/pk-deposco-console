/**
 * Bulk-load the go-live item catalog into Deposco, straight from the sheet.
 *
 * Unlike scripts/seed-items.mjs (which sweeps BC by location/sub-type), this takes an
 * EXPLICIT list — the 5-column go-live xlsx — and posts exactly those items, using only
 * what the sheet carries. No BC join, so no brand/style/size/color, price, or cost.
 *
 *   python3 scripts/xlsx-to-json.py "~/Downloads/Items to add in Deposco.xlsx" catalog.json
 *   node scripts/load-catalog.mjs catalog.json              # DRY RUN — prints, no POST
 *   node scripts/load-catalog.mjs catalog.json --post       # actually POST /items
 *   node scripts/load-catalog.mjs catalog.json --post --resume
 *
 * Resumable: every success is appended to <catalog>.done (one item number per line).
 * --resume skips those, so a broken run continues instead of restarting. Failures go to
 * <catalog>.failed.jsonl with the Deposco error, and are always retried on the next run.
 *
 * Env:
 *   DEPOSCO_COMPANY           (BU code, default HIVE)
 *   DEPOSCO_INTEGRATION_NAME  ('' = NO channel, the default — no BC back-reference)
 *   DEPOSCO_MIN_INTERVAL_MS   (throttle, default 350ms — shared limiter from bc-client)
 *   CATALOG_DROP_NONDIGIT_UPC=true  drop UPCs that aren't all digits (default: send the
 *                             sheet's value verbatim — see usableUpc)
 *   CATALOG_LIMIT=N           only process the first N rows (smoke test)
 */
import 'dotenv/config';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import axios from 'axios';
import { ipv4Agent } from '../dist/auth.js';
import { getDeposcoToken } from '../dist/deposco.js';
import { loadDeposcoConfig } from '../dist/sync/config.js';
import { deposcoThrottle } from '../dist/sync/bc-client.js';

const BU = process.env.DEPOSCO_COMPANY || 'HIVE';
const INTEGRATION = process.env.DEPOSCO_INTEGRATION_NAME ?? '';
const DROP_NONDIGIT_UPC = (process.env.CATALOG_DROP_NONDIGIT_UPC ?? 'false').toLowerCase() === 'true';
const LIMIT = parseInt(process.env.CATALOG_LIMIT ?? '0', 10);

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const POST = args.includes('--post');
const RESUME = args.includes('--resume');
if (!src) {
  console.error('usage: node scripts/load-catalog.mjs <catalog.json> [--post] [--resume]');
  process.exit(1);
}

const DONE_FILE = `${src}.done`;
const FAIL_FILE = `${src}.failed.jsonl`;

// The sheet is the source of truth for UPCs — send its value verbatim. ~141 rows carry the
// WebshopVariantCode in the UPC column; that is INTENTIONAL, not corruption: those items are
// self-barcoded with PK's own SKU, so the WVC really is the barcode. Set
// CATALOG_DROP_NONDIGIT_UPC=true to fall back to digits-only.
const usableUpc = (r) => {
  if (!r.upc) return '';
  if (!DROP_NONDIGIT_UPC) return r.upc;
  return r.upc.split('').every((c) => c >= '0' && c <= '9') ? r.upc : '';
};

function buildItem(r) {
  const upc = usableUpc(r);
  return {
    number: r.wvc,
    businessUnit: { businessKey: { code: BU } },
    name: r.desc,
    shortDescription: r.desc,
    longDescription: r.desc,
    active: true,
    salesEnabledFlag: true,
    shippable: true,
    hazmat: false,
    inventoryTrackingEnabled: true,
    unitPrice: 0,
    purchaseCost: 0,
    packs: [{
      type: 'Each', quantity: 1, newPackFlag: false,
      weight: { weight: 0, units: 'lb' },
      dimensions: { length: { measurement: 0, units: 'in' }, width: { measurement: 0, units: 'in' }, height: { measurement: 0, units: 'in' } },
    }],
    ...(upc ? { upcs: { data: [{ value: upc }] } } : {}),
    ...(INTEGRATION ? { channels: [{
      integration: { businessKey: { name: INTEGRATION } },
      listingStatus: 'Linked', saleable: true, packQuantity: 1,
      ref1: r.item, ref2: r.var, ref3: 'EA', ref4: r.wvc,
    }] } : {}),
  };
}

const all = JSON.parse(readFileSync(src, 'utf8'));

// Same WVC twice => same Deposco item (POST /items upserts on number+BU). Collapse so the
// run count matches reality instead of silently posting one row over another.
const byNumber = new Map();
for (const r of all) if (!byNumber.has(r.wvc)) byNumber.set(r.wvc, r);
const collapsed = all.length - byNumber.size;

let rows = [...byNumber.values()];
const done = RESUME && existsSync(DONE_FILE)
  ? new Set(readFileSync(DONE_FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean))
  : new Set();
if (done.size) rows = rows.filter((r) => !done.has(r.wvc));
if (LIMIT > 0) rows = rows.slice(0, LIMIT);

const cfg = loadDeposcoConfig();
const withUpc = rows.filter((r) => usableUpc(r)).length;
console.log(`[load] ${src}: ${all.length} rows -> ${byNumber.size} unique item(s)${collapsed ? ` (${collapsed} duplicate WVC collapsed)` : ''}`);
if (done.size) console.log(`[load] --resume: skipping ${done.size} already loaded`);
console.log(`[load] processing ${rows.length}  |  with UPC ${withUpc}, without ${rows.length - withUpc}${DROP_NONDIGIT_UPC ? '  (DROPPING non-digit UPCs)' : ''}`);
console.log(`[load] target: ${POST ? `POST ${cfg.apiBase} env=${cfg.env} BU=${BU} integration='${INTEGRATION || '(none)'}'` : 'DRY RUN (no POST)'}`);
console.log(`[load] NOTE: sheet-only load — no brand/style/size/color, unitPrice=0, purchaseCost=0.\n`);

if (!POST) {
  for (const r of rows.slice(0, 10)) {
    const it = buildItem(r);
    console.log(`  DRY  ${it.number}  upc=${it.upcs?.data?.[0]?.value ?? '(none)'}  "${it.name}"`);
  }
  if (rows.length > 10) console.log(`  … and ${rows.length - 10} more`);
  console.log(`\n[load] dry run complete. Add --post to write.`);
  process.exit(0);
}

let ok = 0, fail = 0;
const t0 = Date.now();
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  try {
    const token = await getDeposcoToken(cfg);
    await deposcoThrottle();
    await axios.post(`${cfg.apiBase}/items`, buildItem(r), {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      httpsAgent: ipv4Agent, timeout: 30_000,
    });
    ok++;
    appendFileSync(DONE_FILE, `${r.wvc}\n`);
  } catch (e) {
    fail++;
    const msg = e.response?.data?.errors?.[0]?.errorMessage ?? e.response?.status ?? e.message;
    appendFileSync(FAIL_FILE, `${JSON.stringify({ number: r.wvc, item: r.item, var: r.var, error: msg })}\n`);
    console.log(`  ❌ ${r.wvc}: ${JSON.stringify(msg).slice(0, 160)}`);
  }
  if ((i + 1) % 50 === 0 || i === rows.length - 1) {
    const el = (Date.now() - t0) / 1000;
    const rate = (i + 1) / el;
    const eta = Math.round((rows.length - i - 1) / rate);
    console.log(`  … ${i + 1}/${rows.length}  ok=${ok} fail=${fail}  ${rate.toFixed(1)}/s  ETA ${Math.floor(eta / 60)}m${eta % 60}s`);
  }
}
console.log(`\n[load] done — created/updated ${ok}, failed ${fail}`);
if (fail) console.log(`[load] failures -> ${FAIL_FILE}   (re-run with --resume to retry only those)`);
