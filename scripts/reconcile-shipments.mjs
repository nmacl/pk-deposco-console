#!/usr/bin/env node
/**
 * DRIFT CHECK — what Deposco has shipped vs what BC has posted.
 *
 * Why this exists
 * ---------------
 * On 2026-08-26 a day's worth of shipments sat unposted in BC while the `co` worker's own logs
 * looked healthy: run rows said status=ok, and the orders in question had no failure events at
 * all. They had no events of ANY kind — pullShipmentsForSo returns silently when it finds
 * nothing to post, so "reached the order and did nothing" and "never reached the order" are
 * indistinguishable in sync_events. The worker was, in effect, grading its own homework.
 *
 * This asks the two systems directly instead. It never reads sync_events, so it stays true even
 * when the worker's bookkeeping is wrong — which is exactly the failure it is meant to catch.
 *
 * Usage
 *   node scripts/reconcile-shipments.mjs                 # every order with shipment activity
 *   node scripts/reconcile-shipments.mjs --hours 24      # only shipments stamped in the last 24h
 *   node scripts/reconcile-shipments.mjs --orders A,B,C  # just these BC orders
 *   node scripts/reconcile-shipments.mjs --json          # machine-readable summary
 *   node scripts/reconcile-shipments.mjs --out drift.json  # JSON to a file, human log to stdout
 *
 * Read-only. It posts nothing and writes no cursor; fixing is the worker's job (or a manual
 * push). Exit code is 1 when drift is found, so a scheduler can alert on it.
 */
import 'dotenv/config';
import { loadBcConfig, loadDeposcoConfig } from '../dist/sync/config.js';
import { getBcToken } from '../dist/auth.js';
import { getDeposcoToken } from '../dist/deposco.js';
import { authReq, bcApiBase, getCompanyId, odataStr } from '../dist/sync/bc-client.js';
import { fetchOutboundShipments, resolveCustomerOrderNumbers, fetchShippedFromFulfillment, lookupDeposcoOrderId } from '../dist/sync/orders.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const HOURS = flag('hours') ? Number(flag('hours')) : null;
const ONLY = (flag('orders') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const JSON_OUT = argv.includes('--json');
// The shared HTTP client logs rate-limit retries to stdout, so `--json > file` produces a file
// with [http] lines in front of the JSON. --out keeps the two streams apart instead of asking
// the caller to grep the payload back out.
const OUT_FILE = flag('out');
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

const bcCfg = loadBcConfig();
const deposcoCfg = loadDeposcoConfig();
const dToken = await getDeposcoToken(deposcoCfg);
const bcToken = await getBcToken(bcCfg);
const companyId = await getCompanyId(bcCfg, bcToken);
const base = bcApiBase(bcCfg);

/** BC's cumulative shipped qty per line, keyed by Line_No — the same field the worker deltas. */
async function bcShippedByLine(soNumber) {
  const so = (await authReq('get',
    `${base}/companies(${companyId})/salesOrders?$filter=${encodeURIComponent(`number eq '${odataStr(soNumber)}'`)}&$select=id,number,status`,
    bcToken)).value?.[0];
  if (!so) return null;
  const lines = (await authReq('get',
    `${base}/companies(${companyId})/salesOrders(${so.id})/salesOrderLines?$select=sequence,lineObjectNumber,quantity,shippedQuantity`,
    bcToken)).value ?? [];
  const byLine = new Map();
  for (const l of lines) byLine.set(l.sequence, Number(l.shippedQuantity ?? 0));
  return { status: so.status, byLine };
}

// With an explicit order list there is nothing to discover: skip the shipment listing entirely.
// Reading it costs ~60 calls plus a resolve over every salesOrderId on the account, which is a
// long wait to answer a question about three orders.
let shipments = [];
let orderNos;
if (ONLY.length) {
  orderNos = [...ONLY].sort();
  log(`[drift] checking ${orderNos.length} named order(s); skipping the shipment listing`);
} else {
  log('[drift] reading Deposco outbound shipments…');
  shipments = await fetchOutboundShipments(deposcoCfg, dToken);
  const cutoff = HOURS ? new Date(Date.now() - HOURS * 3600_000).toISOString() : null;
  // updatedDate is offset-aware ("2026-08-26T11:18:10-05:00"); compare as instants, not strings.
  const inWindow = shipments.filter((s) => !cutoff || (s.updatedDate && new Date(s.updatedDate).toISOString() >= cutoff));
  log(`[drift] ${shipments.length} shipment(s) total, ${inWindow.length} in window`);
  const byOrder = await resolveCustomerOrderNumbers(deposcoCfg, dToken, inWindow.flatMap((s) => s.salesOrderIds));
  orderNos = [...new Set([...byOrder.values()])].sort();
}
// TRFO* are Deposco transfer orders — the `to` worker's business, not the sales-order pull.
const skippedTransfers = orderNos.filter((o) => /^TRFO/i.test(o));
orderNos = orderNos.filter((o) => !/^TRFO/i.test(o));
log(`[drift] ${orderNos.length} sales order(s) to check${skippedTransfers.length ? ` (${skippedTransfers.length} TRFO transfer order(s) skipped — see sync-to)` : ''}`);

const drift = [];
const clean = [];
const unreadable = [];
// Guard against the failure mode this script nearly shipped with: a wrong filter name makes
// Deposco ignore the filter and return an unfiltered first page, so EVERY order resolves to the
// same customerOrder and every comparison is against the wrong data — which surfaces as a
// confident "0 drift, all clean" and exit 0. A checker whose failure mode is a false all-clear
// is worse than no checker, so prove the lookups are actually discriminating before trusting
// the verdict.
const resolvedIds = new Set();
for (const soNumber of orderNos) {
  try {
    // MUST be `externalOrderNumber` — the BC order number is a customerOrder's EXTERNAL key.
    // Passing `number` is not an error to Deposco, it is simply an unrecognised filter: the API
    // ignores it and hands back an unfiltered first page, so every order "resolves" to the same
    // id and every comparison silently checks the wrong order. Mirrors lookupCustomerOrderId in
    // sync-co.ts, which is the only correct spelling of this call.
    const coId = await lookupDeposcoOrderId(deposcoCfg, dToken, '/orders/customerOrders', { externalOrderNumber: soNumber });
    if (coId === null) { unreadable.push({ order: soNumber, why: 'not found in Deposco customerOrders' }); continue; }
    resolvedIds.add(coId);
    const { lines, truncatedOrders } = await fetchShippedFromFulfillment(deposcoCfg, dToken, coId);
    const depByLine = new Map();
    for (const l of lines) {
      const n = parseInt(l.externalLineNumber ?? '', 10);
      if (!Number.isFinite(n)) continue;
      depByLine.set(n, (depByLine.get(n) ?? 0) + Number(l.shippedQuantity ?? 0));
    }
    const bc = await bcShippedByLine(soNumber);
    if (!bc) { unreadable.push({ order: soNumber, why: 'not found on BC salesOrders (posted/deleted?)' }); continue; }

    let shortUnits = 0;
    const shortLines = [];
    for (const [lineNo, depQty] of depByLine) {
      const bcQty = bc.byLine.get(lineNo) ?? 0;
      const delta = depQty - bcQty;
      if (delta > 0) { shortUnits += delta; shortLines.push({ line: lineNo, deposco: depQty, bc: bcQty, short: delta }); }
    }
    const row = { order: soNumber, bcStatus: bc.status, shortUnits, shortLines, truncated: truncatedOrders };
    if (shortUnits > 0 || truncatedOrders.length) drift.push(row); else clean.push(row);
    log(`  ${shortUnits > 0 ? '❌' : '✓'} ${soNumber}${shortUnits > 0 ? ` — BC short ${shortUnits} unit(s) across ${shortLines.length} line(s)` : ''}${truncatedOrders.length ? ' ⚠ Deposco truncated the line list' : ''}`);
  } catch (e) {
    unreadable.push({ order: soNumber, why: String(e.message ?? e).slice(0, 200) });
    log(`  ⚠ ${soNumber} — ${String(e.message ?? e).slice(0, 160)}`);
  }
}

// If several distinct orders all landed on one Deposco id, the filter is not filtering. Refuse
// to report rather than hand back a clean bill of health derived from the wrong order.
if (resolvedIds.size === 1 && orderNos.length > 3) {
  console.error(`\n[drift] ABORT: ${orderNos.length} orders all resolved to Deposco id ${[...resolvedIds][0]}.`);
  console.error('[drift] The customerOrder lookup is not discriminating — results would be meaningless.');
  console.error('[drift] Check the filter name (must be externalOrderNumber) before trusting any output.');
  process.exit(2);
}

const summary = {
  checkedAt: new Date().toISOString(),
  windowHours: HOURS,
  shipmentsTotal: shipments.length,
  ordersChecked: orderNos.length,
  transfersSkipped: skippedTransfers,
  driftCount: drift.length,
  driftUnits: drift.reduce((n, d) => n + d.shortUnits, 0),
  drift,
  unreadable,
};
if (OUT_FILE) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT_FILE, JSON.stringify(summary, null, 1));
  console.log(`[drift] wrote ${OUT_FILE}`);
}
if (JSON_OUT) console.log(JSON.stringify(summary, null, 1));
else {
  console.log(`\n[drift] ${drift.length} order(s) where Deposco has shipped more than BC has posted (${summary.driftUnits} unit(s) total)`);
  if (drift.length) console.log(`[drift] ${drift.map((d) => d.order).join(',')}`);
  if (unreadable.length) console.log(`[drift] ${unreadable.length} order(s) could not be checked: ${unreadable.map((u) => u.order).join(',')}`);
}
process.exit(drift.length > 0 ? 1 : 0);
