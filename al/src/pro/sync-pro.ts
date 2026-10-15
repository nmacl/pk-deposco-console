/**
 * PURCHASE-RETURN-ORDER sync worker (PROD…, "return to vendor") — sibling of ro/sync-ro.ts.
 * Goods LEAVE the WMS warehouse back to the vendor, so this is the ship-side transfer pattern:
 *
 *   PUSH  BC → Deposco : Released purchase return orders with WMS-located item lines become
 *                        Deposco customerOrders (create-only — CO POST does not upsert), ship-to =
 *                        the vendor's Buy-from address, attention = Vendor Authorization No. (RMA),
 *                        ship via = the header's E-Ship Agent Service (FEDEX_GROUND…).
 *   PULL  Deposco → BC : warehouse ships → shipped qty per line off the fulfillment order →
 *                        delta = shipped − bcReturnQtyShipped → PATCH returnQtyToShip on
 *                        bmiPurchaseReturnLines → bmiPurchaseReturnOrders/Microsoft.NAV.postShipment
 *                        (ship-only; the credit memo stays manual).
 *
 * Modes:
 *   node dist/pro/sync-pro.js --once                 one tick (Released PROD orders)
 *   node dist/pro/sync-pro.js --order PROD004912     sync one (push + post) — console button
 *     --push-only / --post-only                      isolate the halves
 * Gates: PRO_PUSH_ENABLED, PRO_POST_ENABLED (a --order run forces both on).
 * Env: PRO_PREFIX (PROD), PRO_PER_TICK (250), PRO_WMS_LOCATIONS (default TO_WMS_LOCATIONS or
 *      WESTERLY), PRO_THRESHOLD (REQUIRED, full order number — only orders after it sync),
 *      PRO_POST_TIMEOUT_MS (180000), DEPOSCO_TRADING_PARTNER, DEPOSCO_ORDER_SOURCE.
 */
import 'dotenv/config';
import { type AxiosError } from 'axios';
import { getBcToken } from '../auth.js';
import { getDeposcoToken, type DeposcoConfig } from '../deposco.js';
import { loadBcConfig, loadDeposcoConfig, type SyncBcConfig } from '../sync/config.js';
import { bmiApiBase, getCompanyId, authReq } from '../sync/bc-client.js';
import { postDeposcoOrder, lookupDeposcoOrderId, fetchShippedFromFulfillment, ensureItemsExist } from '../sync/orders.js';
import { startRun, finishRun, logEvent, closeDb, dailyDedupe } from '../sync/db-log.js';

const INTERVAL_MS = parseInt(process.env.PRO_SYNC_INTERVAL_MS ?? '60000', 10);
const PREFIX = process.env.PRO_PREFIX ?? 'PROD';
const PER_TICK = parseInt(process.env.PRO_PER_TICK ?? '250', 10);
const POST_TIMEOUT_MS = parseInt(process.env.PRO_POST_TIMEOUT_MS ?? '180000', 10);
const PUSH_ENABLED = (process.env.PRO_PUSH_ENABLED ?? 'false').toLowerCase() === 'true';
const POST_ENABLED = (process.env.PRO_POST_ENABLED ?? 'false').toLowerCase() === 'true';
const BU = process.env.DEPOSCO_COMPANY || 'HIVE';
const TRADING_PARTNER = process.env.DEPOSCO_TRADING_PARTNER || 'CTPK068417';
const ORDER_SOURCE = process.env.DEPOSCO_ORDER_SOURCE ?? 'BusinessCentralOnline';
const WMS_LOCATIONS = new Set(
  (process.env.PRO_WMS_LOCATIONS ?? process.env.TO_WMS_LOCATIONS ?? 'WESTERLY')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
// Same go-live guard as RO_THRESHOLD: returns at or below this were shipped by hand.
const THRESHOLD = process.env.PRO_THRESHOLD ?? '';
const DEPOSCO_NAME_MAX = 30;
const capName = (v: string): string => (v.length <= DEPOSCO_NAME_MAX ? v : v.slice(0, DEPOSCO_NAME_MAX).trim());

const esc = (s: string): string => s.replace(/'/g, "''");
const toDate = (iso: string): string => (iso && iso !== '0001-01-01' ? iso.slice(0, 10) : '');
const toDateTime = (iso: string): string => { const d = toDate(iso); return d ? `${d}T00:00:00Z` : ''; };

// ── BC reads (our own bmi pages, AL >= 2.21) ─────────────────────────────────
interface ProHeader {
  systemId: string; no: string; status: string; buyFromVendorNo: string; buyFromVendorName: string;
  buyFromAddress: string; buyFromAddress2: string; buyFromCity: string; buyFromCounty: string;
  buyFromPostCode: string; buyFromCountry: string; buyFromContact: string;
  locationCode: string; orderDate: string; postingDate: string; vendorAuthorizationNo: string;
  eShipAgentService: string; lastReturnShipmentNo: string;
}
interface ProLine {
  '@odata.etag'?: string; systemId: string; documentNo: string; lineNo: number; type: string;
  itemNo: string; variantCode: string; webshopVariantCode: string; locationCode: string;
  quantity: number; outstandingQuantity: number; returnQtyToShip: number; returnQtyShipped: number;
}

async function listReturnOrders(bmi: string, token: string): Promise<ProHeader[]> {
  const filter = encodeURIComponent(`startswith(no,'${esc(PREFIX)}') and status eq 'Released' and no gt '${esc(THRESHOLD)}'`);
  const rows = (await authReq<{ value: ProHeader[] }>('get', `${bmi}/bmiPurchaseReturnOrders?$filter=${filter}&$orderby=no asc&$top=${PER_TICK}`, token)).value ?? [];
  if (rows.length >= PER_TICK) console.warn(`[tick] ⚠ hit the ${PER_TICK}-order cap — raise PRO_PER_TICK.`);
  return rows;
}
async function getReturnOrder(bmi: string, token: string, no: string): Promise<ProHeader | null> {
  return (await authReq<{ value: ProHeader[] }>('get', `${bmi}/bmiPurchaseReturnOrders?$filter=${encodeURIComponent(`no eq '${esc(no)}'`)}`, token)).value?.[0] ?? null;
}
async function getLines(bmi: string, token: string, no: string): Promise<ProLine[]> {
  const lines = (await authReq<{ value: ProLine[] }>('get', `${bmi}/bmiPurchaseReturnLines?$filter=${encodeURIComponent(`documentNo eq '${esc(no)}'`)}`, token)).value ?? [];
  // Blank WebshopVariantCode on the line → resolve from the Item Variant mapping (same gap as TO/RO).
  const needs = lines.filter((l) => !l.webshopVariantCode && l.itemNo && l.variantCode);
  for (const itemNo of new Set(needs.map((n) => n.itemNo))) {
    const vs = (await authReq<{ value: { code: string; webshopVariantCode: string }[] }>('get', `${bmi}/bmiItemVariants?$filter=${encodeURIComponent(`itemNo eq '${esc(itemNo)}'`)}`, token)).value ?? [];
    const byCode = new Map(vs.filter((v) => v.webshopVariantCode).map((v) => [String(v.code).toUpperCase(), v.webshopVariantCode]));
    for (const l of needs.filter((n) => n.itemNo === itemNo)) { const c = byCode.get(String(l.variantCode).toUpperCase()); if (c) l.webshopVariantCode = c; }
  }
  return lines;
}

const pushable = (l: ProLine): boolean =>
  l.type === 'Item' && WMS_LOCATIONS.has((l.locationCode ?? '').toUpperCase()) && !!l.webshopVariantCode && (l.outstandingQuantity ?? l.quantity) > 0;

// ── Push: return order → Deposco customerOrder (ship to the vendor) ─────────
function shipVia(h: ProHeader): { shipVia: string; shipVendor: string } | null {
  const svc = (h.eShipAgentService ?? '').trim();
  if (!svc) return null;
  // The purchase header carries no agent code; the vendor is implied by the E-Ship service name.
  const vendor = /^FEDEX/i.test(svc) ? 'FEDEX' : /UPS|AIR|GROUND|SELECT|EXPEDITED|EXPRESS/i.test(svc) ? 'UPS' : '';
  return { shipVia: svc, shipVendor: vendor };
}

function buildAsCustomerOrder(h: ProHeader, lines: ProLine[]): unknown {
  const name = h.buyFromVendorName || h.buyFromVendorNo;
  const parts = name.split(/\s+/);
  const via = shipVia(h);
  return {
    customerOrder: {
      businessUnit: { businessKey: { code: BU } },
      tradingPartner: { businessKey: { code: TRADING_PARTNER, 'businessUnit.code': BU } },
      primarySalesChannel: { businessKey: { code: BU } },
      externalOrderNumber: h.no,
      orderSource: ORDER_SOURCE,
      placedDate: toDateTime(h.orderDate || h.postingDate),
      ...(via ? { shipVia: via.shipVia, ...(via.shipVendor ? { shipVendor: via.shipVendor } : {}), freightTermsType: 'Prepaid' } : {}),
      // Destination = the vendor (Buy-from). The return order's own Ship-to is where the goods
      // sit NOW (a location/decorator address), not where they go.
      shipToContact: {
        attention: h.vendorAuthorizationNo ? `RMA ${h.vendorAuthorizationNo}` : (h.buyFromContact || name),
        firstName: capName(parts[0] || name || 'N/A'),
        lastName: capName(parts.slice(1).join(' ') || parts[0] || 'N/A'),
        line1: h.buyFromAddress, line2: h.buyFromAddress2 ?? '', city: h.buyFromCity,
        stateProvince: h.buyFromCounty, postalCode: h.buyFromPostCode, country: h.buyFromCountry || 'US',
      },
      channels: [],
      coLines: { data: lines.map((l) => ({ externalLineNumber: String(l.lineNo), itemNumber: l.webshopVariantCode, orderQuantity: l.outstandingQuantity ?? l.quantity, packQuantity: 1 })) },
    },
  };
}

type PushOutcome = { kind: 'pushed'; lines: number } | { kind: 'exists' } | { kind: 'none'; attempted: number; noVariant: number; nonWms: number };

async function pushReturn(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, bmi: string, token: string, h: ProHeader): Promise<PushOutcome> {
  const dToken = await getDeposcoToken(deposcoCfg);
  if (await lookupDeposcoOrderId(deposcoCfg, dToken, '/orders/customerOrders', { externalOrderNumber: h.no }) !== null) {
    console.log(`[push] ${h.no}: customerOrder already in Deposco — skipping create (no upsert)`);
    return { kind: 'exists' };
  }
  const raw = await getLines(bmi, token, h.no);
  const ok = raw.filter(pushable);
  if (ok.length === 0) {
    const nonWms = raw.filter((l) => l.type === 'Item' && !WMS_LOCATIONS.has((l.locationCode ?? '').toUpperCase())).length;
    const noVariant = raw.filter((l) => l.type === 'Item' && !l.webshopVariantCode).length;
    console.warn(`[push] ${h.no}: ⚠ 0 pushable line(s) — NOTHING sent (${nonWms} non-WMS location, ${noVariant} missing WebshopVariantCode, of ${raw.length})`);
    return { kind: 'none', attempted: raw.length, noVariant, nonWms };
  }
  for (const l of ok) console.log(`  L${l.lineNo} ${l.itemNo} → ${l.webshopVariantCode} qty=${l.outstandingQuantity ?? l.quantity}`);
  const payload = buildAsCustomerOrder(h, ok) as { customerOrder: { shipVia?: string; coLines: { data: Array<{ itemNumber: string }> } } };
  if (!payload.customerOrder.shipVia) console.warn(`[push] ${h.no}: ⚠ no E-Ship Agent Service on the return order — CO may land in review`);
  const pre = await ensureItemsExist(cfg, deposcoCfg, dToken, payload.customerOrder.coLines.data.map((l) => l.itemNumber));
  if (pre.length) console.log(`[push] ${h.no}: pre-created ${pre.length} missing item(s): ${pre.join(', ')}`);
  await postDeposcoOrder(cfg, deposcoCfg, '/orders/customerOrders', payload, h.no, `${ok.length} line(s) as CO (return to ${h.buyFromVendorName})${payload.customerOrder.shipVia ? `, via ${payload.customerOrder.shipVia}` : ''}`, { worker: 'pro' });
  return { kind: 'pushed', lines: ok.length };
}

// ── Pull: Deposco shipped → PATCH staging → postShipment ───────────────────
interface PostedShipment { staged: number; shipmentNo: string }

async function pullReturn(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, bmi: string, h: ProHeader): Promise<PostedShipment | null> {
  const dToken = await getDeposcoToken(deposcoCfg);
  const coId = await lookupDeposcoOrderId(deposcoCfg, dToken, '/orders/customerOrders', { externalOrderNumber: h.no });
  if (coId === null) { console.log(`[pull] ${h.no}: not in Deposco yet — skip`); return null; }
  const ship = await fetchShippedFromFulfillment(deposcoCfg, dToken, coId);
  if (ship.truncatedOrders.length) console.error(`[pull] ${h.no}: ❌ Deposco truncated the line list on ${ship.truncatedOrders.join(', ')} — shipped qty beyond the first page will NOT post.`);
  const byLine = new Map<number, number>();
  for (const l of ship.lines) { const n = parseInt(l.externalLineNumber ?? '', 10); if (Number.isFinite(n)) byLine.set(n, (byLine.get(n) ?? 0) + Number(l.shippedQuantity ?? 0)); }
  console.log(`[pull] ${h.no}: Deposco shipped ${[...byLine].map(([k, v]) => `L${k}=${v}`).join(' ') || '(none)'}`);

  const token = await getBcToken(cfg);
  let staged = 0;
  for (const l of await getLines(bmi, token, h.no)) {
    const toPost = (byLine.get(l.lineNo) ?? 0) - (l.returnQtyShipped ?? 0);
    if (toPost <= 0) continue;
    await authReq('patch', `${bmi}/bmiPurchaseReturnLines(${l.systemId})`, token, { data: { returnQtyToShip: toPost }, headers: { 'If-Match': String(l['@odata.etag'] ?? '*') } });
    console.log(`  L${l.lineNo} ${l.itemNo}: deposco=${byLine.get(l.lineNo)} bc=${l.returnQtyShipped} → returnQtyToShip = ${toPost}`);
    staged += toPost;
  }
  if (staged === 0) { console.log(`[pull] ${h.no}: nothing to post (in sync)`); return null; }
  console.log(`[pull] ${h.no}: postShipment — staged ${staged} unit(s)`);
  await authReq('post', `${bmi}/bmiPurchaseReturnOrders(${h.systemId})/Microsoft.NAV.postShipment`, token, { data: {}, timeout: POST_TIMEOUT_MS });
  const after = await getReturnOrder(bmi, token, h.no);
  const shipmentNo = after?.lastReturnShipmentNo ?? '';
  console.log(`[pull] ${h.no}: ✅ postShipment → BC return shipment ${shipmentNo || '(unknown)'}`);
  return { staged, shipmentNo };
}

// ── Single-order + tick ──────────────────────────────────────────────────────
interface SyncResult { push?: PushOutcome; posted?: PostedShipment | null; postError?: { status?: number; body: string } }

async function syncOne(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, bmi: string, token: string, h: ProHeader, opts: { push: boolean; post: boolean }): Promise<SyncResult> {
  console.log(`[pro] ${h.no}: vendor ${h.buyFromVendorNo} ${h.buyFromVendorName} @${h.locationCode}`);
  let push: PushOutcome | undefined;
  if (opts.push) push = await pushReturn(cfg, deposcoCfg, bmi, token, h);
  let posted: PostedShipment | null | undefined;
  let postError: SyncResult['postError'];
  if (opts.post) {
    try { posted = await pullReturn(cfg, deposcoCfg, bmi, h); }
    catch (err) {
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
  const bmi = `${bmiApiBase(cfg)}/companies(${await getCompanyId(cfg, token)})`;
  const runId = await startRun('pro', process.env.SYNC_TRIGGER || 'manual');
  let orders: ProHeader[];
  try { orders = await listReturnOrders(bmi, token); }
  catch (err) {
    const e = err as AxiosError & { httpStatus?: number };
    const msg = `list failed: HTTP ${e.httpStatus ?? e.response?.status ?? (e as Error).message} — is AL >= 2.21 (bmiPurchaseReturnOrders) published?`;
    console.error(`[tick] ${msg}`);
    await logEvent({ runId, worker: 'pro', action: 'list', status: 'fail', side: 'bc', message: msg, dedupeKey: dailyDedupe('pro-list', PREFIX, msg) });
    await finishRun(runId, 'error', { posted: 0, failed: 1 });
    return;
  }
  console.log(`[tick] ${orders.length} purchase return order(s)`);
  let processed = 0, failed = 0, desynced = 0;
  for (const h of orders) {
    processed++;
    try {
      const { push, posted, postError } = await syncOne(cfg, deposcoCfg, bmi, token, h, { push: PUSH_ENABLED, post: POST_ENABLED });
      if (postError) {
        failed++;
        const pmsg = `post-back to BC: HTTP ${postError.status ?? '?'}: ${postError.body.slice(0, 300)}`;
        await logEvent({ runId, worker: 'pro', direction: 'deposco->bc', entityType: 'order', entityId: h.no, action: 'post', status: 'fail', side: 'bc', message: pmsg, detail: postError.body.slice(0, 4000), dedupeKey: dailyDedupe('pro-post', h.no, pmsg) });
      }
      if (posted) await logEvent({ runId, worker: 'pro', direction: 'deposco->bc', entityType: 'order', entityId: h.no, action: 'post', status: 'ok', side: 'bc', message: `posted return shipment: ${posted.staged} unit(s)${posted.shipmentNo ? ` → ${posted.shipmentNo}` : ''}`, dedupeKey: dailyDedupe('pro-post-ok', h.no, `${posted.shipmentNo || posted.staged}`) });
      if (push?.kind === 'none') {
        desynced++;
        const msg = `0 pushable line(s) — NOTHING sent (${push.nonWms} non-WMS location, ${push.noVariant} missing WebshopVariantCode, of ${push.attempted})`;
        await logEvent({ runId, worker: 'pro', direction: 'bc->deposco', entityType: 'order', entityId: h.no, action: 'push', status: 'desync', side: 'bc', message: msg, dedupeKey: dailyDedupe('pro-nopush', h.no, msg) });
      } else if (push?.kind === 'pushed') {
        await logEvent({ runId, worker: 'pro', direction: 'bc->deposco', entityType: 'order', entityId: h.no, action: 'sync', status: 'ok', message: `pushed as CO (${push.lines} line(s))`, dedupeKey: dailyDedupe('pro', h.no, `ok:${push.lines}`) });
      }
    } catch (err) {
      const e = err as AxiosError & { httpStatus?: number };
      const body = JSON.stringify(e.response?.data ?? e.message).slice(0, 300);
      const status = e.response?.status ?? e.httpStatus;
      const side = status === 429 || /EOM|not subscribed|deposco/i.test(body) ? 'deposco' : 'bc';
      console.error(`[pro] ${h.no} FAILED HTTP ${status}: ${body}`);
      failed++;
      await logEvent({ runId, worker: 'pro', direction: 'bc->deposco', entityType: 'order', entityId: h.no, action: 'sync', status: 'fail', side, message: `HTTP ${status}: ${body.slice(0, 180)}`, dedupeKey: dailyDedupe('pro', h.no, `HTTP ${status}`) });
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
  if (!THRESHOLD || !THRESHOLD.toUpperCase().startsWith(PREFIX.toUpperCase())) {
    console.error(`[pro-sync] PRO_THRESHOLD ${THRESHOLD ? `'${THRESHOLD}' doesn't start with '${PREFIX}'` : 'is not set'} — refusing to run. Set a full order number (e.g. PRO_THRESHOLD=${PREFIX}004911); only orders AFTER it sync.`);
    process.exit(1);
  }
  if (orderArg && orderArg.toUpperCase() <= THRESHOLD.toUpperCase()) {
    console.error(`[pro] ${orderArg}: at or below PRO_THRESHOLD (${THRESHOLD}) — handled manually, must not sync.`);
    process.exit(3);
  }
  if (orderArg) {
    const pushOnly = process.argv.includes('--push-only');
    const postOnly = process.argv.includes('--post-only');
    const token = await getBcToken(cfg);
    const bmi = `${bmiApiBase(cfg)}/companies(${await getCompanyId(cfg, token)})`;
    const h = await getReturnOrder(bmi, token, orderArg);
    if (!h) { console.error(`[pro] ${orderArg}: not found (bmiPurchaseReturnOrders)`); process.exit(1); }
    if (h.status !== 'Released') { console.error(`[pro] ${orderArg}: status ${h.status} — only Released return orders sync`); process.exit(3); }
    const { push, postError } = await syncOne(cfg, deposcoCfg, bmi, token, h, { push: !postOnly, post: !pushOnly });
    if (push?.kind === 'none') { console.warn(`[pro] ${orderArg}: nothing pushed — flagged as desync`); process.exit(3); }
    if (postError) { console.error(`[pro] ${orderArg}: post-back failed — HTTP ${postError.status ?? '?'}`); process.exit(1); }
    return;
  }
  const once = process.argv.includes('--once');
  console.log(`[pro-sync] starting — prefix=${PREFIX} threshold=${THRESHOLD} push=${PUSH_ENABLED} post=${POST_ENABLED} wms=[${[...WMS_LOCATIONS].join(',')}]${once ? ' (single tick)' : ''}`);
  if (once) { await tick(cfg, deposcoCfg); await closeDb(); return; }
  for (;;) {
    const t0 = Date.now();
    try { await tick(cfg, deposcoCfg); } catch (err) { console.error('[tick] FAILED:', err instanceof Error ? err.message : err); }
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t0)));
  }
}

main().catch((err) => { console.error('FATAL:', err instanceof Error ? err.message : err); process.exit(1); });
