/**
 * SALES-RETURN-ORDER sync worker (SRTO…) — sibling of po/co/to. Customer returns come back INTO
 * the WMS warehouse, so the flow is the WSP purchase-order pattern:
 *
 *   PUSH  BC → Deposco : Released return orders with WMS-located item lines become Deposco
 *                        purchaseOrders (upsert by number — re-push is always safe, and there is
 *                        no duplicate/cancelled-copy problem like customerOrders have).
 *   PULL  Deposco → BC : warehouse receives the return in Deposco → delta per line =
 *                        deposcoReceived − bcReturnQtyReceived → PATCH returnQtyToReceive on
 *                        bmiSalesReturnLines (our own AL page — prod refreshes can't wipe it the
 *                        way they wipe OData web services) → fire bmiSalesReturnOrders
 *                        Microsoft.NAV.postReceipt (receive-only; the credit memo stays manual).
 *
 * Stateless full scan every tick, like co/to — no cursor to starve or wedge. Successful
 * post-backs are logged as ok events with the posted Return Receipt No. (read back from the
 * header's lastReturnReceiptNo after the action).
 *
 * Modes:
 *   node dist/ro/sync-ro.js                 continuous loop
 *   node dist/ro/sync-ro.js --once          one tick (Released return orders)
 *   node dist/ro/sync-ro.js --order SRTO001234        sync one (push + post) — console button
 *     --push-only / --post-only             isolate the halves
 * Gates: RO_PUSH_ENABLED (push to Deposco), RO_POST_ENABLED (post receipts in BC).
 * A --order run forces both on for that one order.
 *
 * Env: RO_SYNC_INTERVAL_MS (60000), RO_PREFIX (SRTO), RO_PER_TICK (250),
 *      RO_WMS_LOCATIONS (default = TO_WMS_LOCATIONS or WESTERLY), DEPOSCO_*, BC_*.
 */
import 'dotenv/config';
import { type AxiosError } from 'axios';
import { getBcToken } from '../auth.js';
import { getDeposcoToken, type DeposcoConfig } from '../deposco.js';
import { loadBcConfig, loadDeposcoConfig, type SyncBcConfig } from '../sync/config.js';
import { bmiApiBase, getCompanyId, authReq } from '../sync/bc-client.js';
import { postDeposcoOrder, lookupDeposcoOrderId, fetchReceivedFromPurchaseOrder } from '../sync/orders.js';
import { startRun, finishRun, logEvent, closeDb, dailyDedupe } from '../sync/db-log.js';

const INTERVAL_MS = parseInt(process.env.RO_SYNC_INTERVAL_MS ?? '60000', 10);
const PREFIX = process.env.RO_PREFIX ?? 'SRTO';
const PER_TICK = parseInt(process.env.RO_PER_TICK ?? '250', 10);
// Receipt posting writes item ledger + (customization) SKU auto-create — same heavyweight class
// as transfer posting, which blew the 30s default live. Give it the same room.
const POST_TIMEOUT_MS = parseInt(process.env.RO_POST_TIMEOUT_MS ?? '180000', 10);
const PUSH_ENABLED = (process.env.RO_PUSH_ENABLED ?? 'false').toLowerCase() === 'true';
const POST_ENABLED = (process.env.RO_POST_ENABLED ?? 'false').toLowerCase() === 'true';
const BU = process.env.DEPOSCO_COMPANY || 'HIVE';
const ORDER_SOURCE = process.env.DEPOSCO_ORDER_SOURCE ?? 'BusinessCentralOnline';
const WMS_LOCATIONS = new Set(
  (process.env.RO_WMS_LOCATIONS ?? process.env.TO_WMS_LOCATIONS ?? 'WESTERLY')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
// Go-live cutoff, same pattern as PO_THRESHOLD on the WSP worker: return orders at or below this
// number NEVER sync. Chris has been handling returns by hand (receive into PK + manual Deposco
// adjustment); pushing that history would create open Deposco POs whose stock was already
// adjusted in — receiving one would double-count. REQUIRED to be set before the worker runs:
// an empty threshold refuses to tick rather than silently syncing all of history.
const THRESHOLD = process.env.RO_THRESHOLD ?? '';

const esc = (s: string): string => s.replace(/'/g, "''");
const toDate = (iso: string): string => (iso && iso !== '0001-01-01' ? iso.slice(0, 10) : '');
const toDateTime = (iso: string): string => { const d = toDate(iso); return d ? `${d}T00:00:00Z` : ''; };

// ── BC reads (all from our own bmi pages) ────────────────────────────────────
interface RoHeader {
  systemId: string; no: string; status: string; sellToCustomerNo: string; sellToCustomerName: string;
  externalDocumentNo: string; orderDate: string; postingDate: string; locationCode: string;
  lastReturnReceiptNo: string;
}
interface RoLine {
  '@odata.etag'?: string; systemId: string; documentNo: string; lineNo: number; type: string;
  itemNo: string; variantCode: string; webshopVariantCode: string; locationCode: string;
  description: string; quantity: number; returnQtyToReceive: number; returnQtyReceived: number;
}

async function listReturnOrders(bmi: string, token: string): Promise<RoHeader[]> {
  const filter = encodeURIComponent(`startswith(no,'${esc(PREFIX)}') and status eq 'Released' and no gt '${esc(THRESHOLD)}'`);
  const url = `${bmi}/bmiSalesReturnOrders?$filter=${filter}&$orderby=no asc&$top=${PER_TICK}`;
  const rows = (await authReq<{ value: RoHeader[] }>('get', url, token)).value ?? [];
  if (rows.length >= PER_TICK) console.warn(`[tick] ⚠ hit the ${PER_TICK}-order cap — Released return orders may be unseen. Raise RO_PER_TICK.`);
  return rows;
}

async function getReturnOrder(bmi: string, token: string, no: string): Promise<RoHeader | null> {
  const url = `${bmi}/bmiSalesReturnOrders?$filter=${encodeURIComponent(`no eq '${esc(no)}'`)}`;
  return (await authReq<{ value: RoHeader[] }>('get', url, token)).value?.[0] ?? null;
}

async function getLines(bmi: string, token: string, no: string): Promise<RoLine[]> {
  const url = `${bmi}/bmiSalesReturnLines?$filter=${encodeURIComponent(`documentNo eq '${esc(no)}'`)}`;
  const lines = (await authReq<{ value: RoLine[] }>('get', url, token)).value ?? [];
  // UPG doesn't reliably stamp WebshopVariantCode everywhere (blank on transfer lines; assume the
  // same can happen here). The Item Variant mapping is authoritative — resolve blanks from it.
  const needs = lines.filter((l) => !l.webshopVariantCode && l.itemNo && l.variantCode);
  for (const itemNo of new Set(needs.map((l) => l.itemNo))) {
    const vurl = `${bmi}/bmiItemVariants?$filter=${encodeURIComponent(`itemNo eq '${esc(itemNo)}'`)}`;
    const vs = (await authReq<{ value: { code: string; webshopVariantCode: string }[] }>('get', vurl, token)).value ?? [];
    const byCode = new Map(vs.filter((v) => v.webshopVariantCode).map((v) => [String(v.code).toUpperCase(), v.webshopVariantCode]));
    for (const l of needs.filter((n) => n.itemNo === itemNo)) {
      const code = byCode.get(String(l.variantCode).toUpperCase());
      if (code) l.webshopVariantCode = code;
    }
  }
  return lines;
}

// WMS-located item lines with a resolvable webshop code are what Deposco can receive.
const pushable = (l: RoLine): boolean =>
  l.type === 'Item' && WMS_LOCATIONS.has((l.locationCode ?? '').toUpperCase()) && !!l.webshopVariantCode && l.quantity > 0;

// ── Push: return order → Deposco purchaseOrder (upsert by number) ───────────
function buildAsPurchaseOrder(h: RoHeader, lines: RoLine[]): unknown {
  return {
    businessUnit: { businessKey: { code: BU } },
    number: h.no,
    orderDate: toDate(h.orderDate || h.postingDate),
    plannedArrivalDate: toDateTime(h.postingDate || h.orderDate),
    placedDate: toDateTime(h.orderDate || h.postingDate),
    shipToFacility: { businessKey: { number: BU } },
    orderSource: ORDER_SOURCE,
    orderLines: {
      data: lines.map((l) => ({
        lineNumber: `${h.no}-${l.lineNo}`,
        item: { businessKey: { number: l.webshopVariantCode, 'businessUnit.code': BU } },
        pack: { businessKey: { 'item.number': l.webshopVariantCode, quantity: 1, 'item.businessUnit.code': BU } },
        orderPackQuantity: l.quantity,
        unitCost: 0,
      })),
    },
  };
}

type PushOutcome =
  | { kind: 'pushed'; lines: number }
  | { kind: 'none'; attempted: number; noVariant: number; nonWms: number };

async function pushReturn(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, bmi: string, token: string, h: RoHeader): Promise<PushOutcome> {
  const raw = await getLines(bmi, token, h.no);
  const ok = raw.filter(pushable);
  if (ok.length === 0) {
    const nonWms = raw.filter((l) => l.type === 'Item' && !WMS_LOCATIONS.has((l.locationCode ?? '').toUpperCase())).length;
    const noVariant = raw.filter((l) => l.type === 'Item' && l.quantity > 0 && !l.webshopVariantCode).length;
    console.warn(`[push] ${h.no}: ⚠ 0 pushable line(s) — NOTHING sent (${nonWms} non-WMS location, ${noVariant} missing WebshopVariantCode, of ${raw.length})`);
    return { kind: 'none', attempted: raw.length, noVariant, nonWms };
  }
  for (const l of ok) console.log(`  L${l.lineNo} item=${l.itemNo} → ${l.webshopVariantCode} qty=${l.quantity}`);
  await postDeposcoOrder(cfg, deposcoCfg, '/orders/purchaseOrders', buildAsPurchaseOrder(h, ok), h.no, `${ok.length} line(s) as PO (return receive)`, { worker: 'ro' });
  return { kind: 'pushed', lines: ok.length };
}

// ── Pull: Deposco receipts → PATCH staging → postReceipt ────────────────────
interface PostedReceipt { staged: number; receiptNo: string }

async function pullReturn(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, bmi: string, h: RoHeader): Promise<PostedReceipt | null> {
  const dToken = await getDeposcoToken(deposcoCfg);
  const poId = await lookupDeposcoOrderId(deposcoCfg, dToken, '/orders/purchaseOrders', { number: h.no });
  if (poId === null) { console.log(`[pull] ${h.no}: not in Deposco yet — skip`); return null; }
  const received = await fetchReceivedFromPurchaseOrder(deposcoCfg, dToken, poId);
  if (received.truncated) console.error(`[pull] ${h.no}: ❌ Deposco truncated the PO line list — received qty beyond the first page is unreadable and will NOT post.`);
  const byLine = new Map<number, number>();
  for (const r of received.lines) byLine.set(r.line, (byLine.get(r.line) ?? 0) + r.quantity);
  console.log(`[pull] ${h.no}: Deposco received ${[...byLine].map(([k, v]) => `L${k}=${v}`).join(' ') || '(none)'}`);

  const token = await getBcToken(cfg);
  const lines = await getLines(bmi, token, h.no);
  let staged = 0;
  for (const l of lines) {
    const dep = byLine.get(l.lineNo) ?? 0;
    const toPost = dep - (l.returnQtyReceived ?? 0);
    if (toPost <= 0) continue;
    await authReq('patch', `${bmi}/bmiSalesReturnLines(${l.systemId})`, token,
      { data: { returnQtyToReceive: toPost }, headers: { 'If-Match': String(l['@odata.etag'] ?? '*') } });
    console.log(`  L${l.lineNo} ${l.itemNo}: deposco=${dep} bc=${l.returnQtyReceived} → returnQtyToReceive = ${toPost}`);
    staged += toPost;
  }
  if (staged === 0) { console.log(`[pull] ${h.no}: nothing to post (in sync)`); return null; }
  console.log(`[pull] ${h.no}: postReceipt — staged ${staged} unit(s)`);
  await authReq('post', `${bmi}/bmiSalesReturnOrders(${h.systemId})/Microsoft.NAV.postReceipt`, token,
    { data: {}, timeout: POST_TIMEOUT_MS });
  const after = await getReturnOrder(bmi, token, h.no);
  const receiptNo = after?.lastReturnReceiptNo ?? '';
  console.log(`[pull] ${h.no}: ✅ postReceipt → BC return receipt ${receiptNo || '(unknown)'}`);
  return { staged, receiptNo };
}

// ── Single-order + tick ──────────────────────────────────────────────────────
interface SyncResult { push?: PushOutcome; posted?: PostedReceipt | null; postError?: { status?: number; body: string } }

async function syncOne(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, bmi: string, token: string, h: RoHeader, opts: { push: boolean; post: boolean }): Promise<SyncResult> {
  console.log(`[ro] ${h.no}: customer ${h.sellToCustomerNo} ${h.sellToCustomerName}`);
  let push: PushOutcome | undefined;
  if (opts.push) push = await pushReturn(cfg, deposcoCfg, bmi, token, h);
  let posted: PostedReceipt | null | undefined;
  let postError: SyncResult['postError'];
  if (opts.post) {
    try {
      posted = await pullReturn(cfg, deposcoCfg, bmi, h);
    } catch (err) {
      const e = err as AxiosError & { httpStatus?: number };
      const body = JSON.stringify(e.response?.data ?? e.message);
      postError = { status: e.response?.status ?? e.httpStatus, body };
      console.error(`[pull] ${h.no} post-back FAILED HTTP ${postError.status ?? '?'}: ${body.slice(0, 500)}`);
    }
  }
  return { push, posted, postError };
}

async function tick(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig): Promise<void> {
  const token = await getBcToken(cfg);
  const companyId = await getCompanyId(cfg, token);
  const bmi = `${bmiApiBase(cfg)}/companies(${companyId})`;
  const runId = await startRun('ro', process.env.SYNC_TRIGGER || 'manual');
  let orders: RoHeader[];
  try {
    orders = await listReturnOrders(bmi, token);
  } catch (err) {
    const e = err as AxiosError & { httpStatus?: number };
    const msg = `list failed: HTTP ${e.httpStatus ?? e.response?.status ?? (e as Error).message} — is the 2.10 AL extension (bmiSalesReturnOrders) published?`;
    console.error(`[tick] ${msg}`);
    await logEvent({ runId, worker: 'ro', action: 'list', status: 'fail', side: 'bc', message: msg, dedupeKey: dailyDedupe('ro-list', PREFIX, msg) });
    await finishRun(runId, 'error', { posted: 0, failed: 1 });
    return;
  }
  console.log(`[tick] ${orders.length} return order(s)`);
  let processed = 0, failed = 0, desynced = 0;
  for (const h of orders) {
    processed++;
    try {
      const { push, posted, postError } = await syncOne(cfg, deposcoCfg, bmi, token, h, { push: PUSH_ENABLED, post: POST_ENABLED });
      if (postError) {
        failed++;
        const pmsg = `post-back to BC: HTTP ${postError.status ?? '?'}: ${postError.body.slice(0, 300)}`;
        await logEvent({ runId, worker: 'ro', direction: 'deposco->bc', entityType: 'order', entityId: h.no, action: 'post', status: 'fail', side: 'bc', message: pmsg, detail: postError.body.slice(0, 4000), dedupeKey: dailyDedupe('ro-post', h.no, pmsg) });
      }
      if (posted) {
        await logEvent({ runId, worker: 'ro', direction: 'deposco->bc', entityType: 'order', entityId: h.no, action: 'post', status: 'ok', side: 'bc', message: `posted return receipt: ${posted.staged} unit(s)${posted.receiptNo ? ` → ${posted.receiptNo}` : ''}`, dedupeKey: dailyDedupe('ro-post-ok', h.no, `${posted.receiptNo || posted.staged}`) });
      }
      if (push?.kind === 'none') {
        desynced++;
        const msg = `0 pushable line(s) — NOTHING sent (${push.nonWms} non-WMS location, ${push.noVariant} missing WebshopVariantCode, of ${push.attempted})`;
        await logEvent({ runId, worker: 'ro', direction: 'bc->deposco', entityType: 'order', entityId: h.no, action: 'push', status: 'desync', side: 'bc', message: msg, dedupeKey: dailyDedupe('ro-nopush', h.no, msg) });
      } else if (push?.kind === 'pushed') {
        await logEvent({ runId, worker: 'ro', direction: 'bc->deposco', entityType: 'order', entityId: h.no, action: 'sync', status: 'ok', message: `pushed as PO (${push.lines} line(s))`, dedupeKey: dailyDedupe('ro', h.no, `ok:${push.lines}`) });
      }
    } catch (err) {
      const e = err as AxiosError & { httpStatus?: number };
      const body = JSON.stringify(e.response?.data ?? e.message).slice(0, 300);
      const status = e.response?.status ?? e.httpStatus;
      const side = status === 429 || /EOM|not subscribed|deposco/i.test(body) ? 'deposco' : 'bc';
      console.error(`[ro] ${h.no} FAILED HTTP ${status}: ${body}`);
      failed++;
      await logEvent({ runId, worker: 'ro', direction: 'bc->deposco', entityType: 'order', entityId: h.no, action: 'sync', status: 'fail', side, message: `HTTP ${status}: ${body.slice(0, 180)}`, dedupeKey: dailyDedupe('ro', h.no, `HTTP ${status}`) });
    }
  }
  await finishRun(runId, failed > 0 ? 'partial' : 'ok', { posted: processed - failed - desynced, failed, desync: desynced });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadBcConfig();
  const deposcoCfg = loadDeposcoConfig();
  const orderIdx = process.argv.indexOf('--order');
  const orderArg = orderIdx >= 0 ? process.argv[orderIdx + 1] : null;

  // No threshold → no sync, loudly. Chris's hand-processed history must never flow (see THRESHOLD).
  if (!THRESHOLD) {
    console.error('[ro-sync] RO_THRESHOLD is not set — refusing to run. Set it to the last hand-processed return order number (e.g. RO_THRESHOLD=SRTO001234); only orders AFTER it will sync.');
    process.exit(1);
  }
  if (orderArg && orderArg.toUpperCase() <= THRESHOLD.toUpperCase()) {
    console.error(`[ro] ${orderArg}: at or below RO_THRESHOLD (${THRESHOLD}) — this return was handled manually and must not sync (double-adjust risk).`);
    process.exit(3);
  }

  if (orderArg) {
    const pushOnly = process.argv.includes('--push-only');
    const postOnly = process.argv.includes('--post-only');
    const token = await getBcToken(cfg);
    const companyId = await getCompanyId(cfg, token);
    const bmi = `${bmiApiBase(cfg)}/companies(${companyId})`;
    const h = await getReturnOrder(bmi, token, orderArg);
    if (!h) { console.error(`[ro] ${orderArg}: not found`); process.exit(1); }
    if (h.status !== 'Released') { console.warn(`[ro] ${orderArg}: status '${h.status}' — only Released return orders sync`); process.exit(3); }
    const { push, postError } = await syncOne(cfg, deposcoCfg, bmi, token, h, { push: !postOnly, post: !pushOnly });
    if (push?.kind === 'none') { console.warn(`[ro] ${orderArg}: nothing pushed — flagged as desync`); process.exit(3); }
    if (postError) { console.error(`[ro] ${orderArg}: post-back failed — HTTP ${postError.status ?? '?'}`); process.exit(1); }
    return;
  }

  const once = process.argv.includes('--once');
  console.log(`[ro-sync] starting — interval=${INTERVAL_MS}ms prefix=${PREFIX} perTick=${PER_TICK} push=${PUSH_ENABLED} post=${POST_ENABLED} wms=[${[...WMS_LOCATIONS].join(',')}]${once ? ' (single tick)' : ''}`);
  if (once) { await tick(cfg, deposcoCfg); await closeDb(); return; }
  for (;;) {
    const t0 = Date.now();
    try { await tick(cfg, deposcoCfg); } catch (err) { console.error('[tick] FAILED:', err instanceof Error ? err.message : err); }
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t0)));
  }
}

main().catch((err) => { console.error('FATAL:', err instanceof Error ? err.message : err); process.exit(1); });
