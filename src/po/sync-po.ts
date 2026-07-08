/**
 * Long-running sync worker — deploy to Railway as a worker process.
 *
 * Every SYNC_INTERVAL_MS:
 *   1. Lists BC Open WSP POs with number > PO_THRESHOLD
 *   2. For each PO:
 *      - Push BC → Deposco: POST /orders/purchaseOrders (creates Deposco PO)
 *      - Pull Deposco → BC: aggregate /receipts, diff vs BC receivedQuantity,
 *        post receive-only via Microsoft.NAV.receiveAndInvoice (invoiceQty=0)
 *
 * Env:
 *   SYNC_INTERVAL_MS  (default 60000)   — sleep between ticks
 *   PO_THRESHOLD      (default WSP32151) — only POs with number > this
 *   BC_*              BC auth + environment + company
 *   DEPOSCO_*         Deposco auth + env + company
 */
import 'dotenv/config';
import { type AxiosError } from 'axios';
import { getBcToken } from '../auth.js';
import { getDeposcoToken, type DeposcoConfig } from '../deposco.js';
import { loadBcConfig, loadDeposcoConfig, type SyncBcConfig } from '../sync/config.js';
import { bcApiBase, bcOdataBase, bmiApiBase, getCompanyId, authReq } from '../sync/bc-client.js';
import { postDeposcoOrder, lookupDeposcoOrderId, fetchDeposcoReceipts, type PostResult } from '../sync/orders.js';

// local alias kept so existing signatures below read unchanged
type BcConfig = SyncBcConfig;

const INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS ?? '60000', 10);
const PO_THRESHOLD = process.env.PO_THRESHOLD ?? 'WSP32236';
// Deposco rejects a purchaseOrders request with >100 order lines
// ("Line count for order X is N which exceeds the limit of 100"). Split into
// chunks of this size, same header, distinct lineNumbers. ASSUMES Deposco appends
// lines across requests (upsert by lineNumber) rather than capping the order total.
const MAX_PO_LINES = parseInt(process.env.MAX_PO_LINES ?? '100', 10);
// Order Source stamped on our Deposco POs. Distinct from the legacy `socket`
// integration's "BusinessCentral". Override via env once we confirm Deposco
// accepts a custom value (it may be a validated set).
const ORDER_SOURCE = process.env.DEPOSCO_ORDER_SOURCE ?? 'BusinessCentralOnline';
// Only push PO lines stocked at a WMS-tracked warehouse (default WMS only). Non-WMS
// lines (PK / dropship / decoration / on-demand) are skipped — Deposco doesn't fulfill
// them. Mirrors co/sync-co.ts SO_WMS_LOCATIONS. Fail-closed: a line whose location can't
// be resolved to a WMS code is dropped (and logged), same as the CO worker.
const WMS_LOCATIONS = new Set((process.env.PO_WMS_LOCATIONS ?? 'WMS').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));

// ────────────────────────────────────────────────────────────────────────────
// BC helpers — config + bcApiBase/bcOdataBase/bmiApiBase/getCompanyId now live in ../sync/*.
// ────────────────────────────────────────────────────────────────────────────

interface BcPurchaseOrder {
  id: string;
  number: string;
  orderDate: string;
  vendorNumber: string;
  vendorName: string;
}

interface BcPurchaseOrderLine {
  id: string;
  sequence: number;
  lineObjectNumber: string;
  description: string;
  description2: string;
  quantity: number;
  receivedQuantity: number;
  directUnitCost: number;
  expectedReceiptDate: string;
  itemVariantId: string;
}

async function listOpenWspPosAbove(
  base: string,
  token: string,
  companyId: string,
  threshold: string,
): Promise<BcPurchaseOrder[]> {
  // No status filter — BC v2.0 only exposes Draft/In Review/Open on this instance,
  // and push/receive work against all three.
  const filter = encodeURIComponent(
    `startswith(number,'WSP') and number gt '${threshold}'`,
  );
  const select = encodeURIComponent('id,number,orderDate,vendorNumber,vendorName');
  const body = await authReq<{ value: BcPurchaseOrder[] }>('get',
    `${base}/companies(${companyId})/purchaseOrders?$filter=${filter}&$select=${select}`, token);
  return body.value;
}

async function getPoByNumber(
  base: string,
  token: string,
  companyId: string,
  poNumber: string,
): Promise<BcPurchaseOrder | null> {
  const filter = encodeURIComponent(`number eq '${poNumber}'`);
  const body = await authReq<{ value: BcPurchaseOrder[] }>('get',
    `${base}/companies(${companyId})/purchaseOrders?$filter=${filter}`, token);
  return body.value[0] ?? null;
}

async function getLines(
  base: string,
  token: string,
  companyId: string,
  poId: string,
): Promise<BcPurchaseOrderLine[]> {
  const body = await authReq<{ value: BcPurchaseOrderLine[] }>('get',
    `${base}/companies(${companyId})/purchaseOrders(${poId})/purchaseOrderLines`, token);
  return body.value;
}

async function patchLine(
  base: string,
  token: string,
  companyId: string,
  lineId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return authReq<Record<string, unknown>>('patch',
    `${base}/companies(${companyId})/purchaseOrderLines(${lineId})`, token,
    { data: body, headers: { 'If-Match': '*' } });
}

async function setVendorInvoiceNo(
  odata: string,
  token: string,
  poNumber: string,
  vendorInvNo: string,
): Promise<void> {
  const body = await authReq<{ value: Array<{ '@odata.etag': string }> }>('get',
    `${odata}/Purchase_Order?$filter=No eq '${poNumber}'`, token);
  const po = body.value[0];
  if (!po) throw new Error(`PO ${poNumber} not found via ODataV4`);
  await authReq('patch',
    `${odata}/Purchase_Order(Document_Type='Order',No='${poNumber}')`, token,
    { data: { Vendor_Invoice_No: vendorInvNo }, headers: { 'If-Match': po['@odata.etag'] } });
}

async function postReceiveAndInvoice(
  base: string,
  token: string,
  companyId: string,
  poId: string,
): Promise<void> {
  await authReq('post',
    `${base}/companies(${companyId})/purchaseOrders(${poId})/Microsoft.NAV.receiveAndInvoice`, token,
    { data: {} });
}

// A flattened purchase-order line from our sibling extension's bmiPurchaseOrderLines
// read page (api/bmi/pk/v1.0). One GET returns location + webshopVariantCode + qty +
// cost + expected date per line — replacing the old getLines + getLineLocations +
// resolveWebshopVariantCode (2N+ BC round-trips per PO).
interface BmiPoLine {
  lineNo: number;
  type: string;
  itemNo: string;
  webshopVariantCode: string;
  locationCode: string;
  quantity: number;
  directUnitCost: number;
  expectedReceiptDate: string;
}

async function getBmiPurchaseOrderLines(cfg: BcConfig, companyId: string, poNumber: string): Promise<BmiPoLine[]> {
  const token = await getBcToken(cfg);
  const filter = encodeURIComponent(`documentNo eq '${poNumber.replace(/'/g, "''")}'`);
  const url = `${bmiApiBase(cfg)}/companies(${companyId})/bmiPurchaseOrderLines?$filter=${filter}`;
  const body = await authReq<{ value: BmiPoLine[] }>('get', url, token, { timeout: 60_000 });
  return body.value ?? [];
}

// ────────────────────────────────────────────────────────────────────────────
// Push: BC PO → Deposco  (Deposco order reads live in ../sync/orders.ts)
// ────────────────────────────────────────────────────────────────────────────

interface DeposcoLine {
  lineNumber: string;
  item: { businessKey: { number: string; 'businessUnit.code': string } };
  pack: { businessKey: { 'item.number': string; quantity: number; 'item.businessUnit.code': string } };
  orderPackQuantity: number;
  unitCost: number;
}

interface DeposcoPurchaseOrderPayload {
  businessUnit: { businessKey: { code: string } };
  number: string;
  orderDate: string;
  plannedArrivalDate: string;
  placedDate: string;
  shipToFacility: { businessKey: { number: string } };
  orderStatus?: string;
  orderSource?: string;
  orderLines: { data: DeposcoLine[] };
}

const toDate = (iso: string): string => iso.slice(0, 10);
const toDateTime = (iso: string): string => `${iso.slice(0, 10)}T00:00:00Z`;

function buildDeposcoPayload(
  po: BcPurchaseOrder,
  lines: BmiPoLine[],
  includeStatus: boolean,
): DeposcoPurchaseOrderPayload {
  const earliestExpected = lines
    .map((l) => l.expectedReceiptDate)
    .filter((d) => d && d !== '0001-01-01')
    .sort()[0] ?? po.orderDate;

  return {
    businessUnit: { businessKey: { code: 'HIVE' } },
    number: po.number,
    orderDate: toDate(po.orderDate),
    plannedArrivalDate: toDateTime(earliestExpected),
    placedDate: toDateTime(po.orderDate),
    shipToFacility: { businessKey: { number: 'HIVE' } },
    ...(includeStatus ? { orderStatus: 'New' } : {}),
    orderSource: ORDER_SOURCE,
    orderLines: {
      data: lines.map((l) => ({
        lineNumber: `${po.number}-${l.lineNo}`,
        item: { businessKey: { number: l.webshopVariantCode, 'businessUnit.code': 'HIVE' } },
        pack: { businessKey: { 'item.number': l.webshopVariantCode, quantity: 1, 'item.businessUnit.code': 'HIVE' } },
        orderPackQuantity: l.quantity,
        unitCost: l.directUnitCost,
      })),
    },
  };
}

// Lazy item creation (buildDeposcoItem/parseMissingItemNumbers/createMissingItem) now
// lives in ../sync/items.ts, shared with co/to. Reactive — driven by Deposco's 404
// "Item with business key number = [X] ... does not exist"; only adds missing items.

// POST one PO chunk via the shared lazy-create-retry poster.
async function postPoChunk(
  bcCfg: BcConfig,
  deposcoCfg: DeposcoConfig,
  po: BcPurchaseOrder,
  payload: DeposcoPurchaseOrderPayload,
  label: string,
): Promise<PostResult> {
  return postDeposcoOrder(bcCfg, deposcoCfg, '/orders/purchaseOrders', payload, po.number, label);
}

async function pushPo(
  bcCfg: BcConfig,
  deposcoCfg: DeposcoConfig,
  companyId: string,
  po: BcPurchaseOrder,
): Promise<void> {
  // Branch on whether Deposco already has this PO: create vs update.
  // Create gets orderStatus='New'; update omits orderStatus (Deposco rejects downgrades).
  // Both paths POST to the same upsert endpoint.
  const deposcoToken = await getDeposcoToken(deposcoCfg);
  const existing = await lookupDeposcoOrderId(deposcoCfg, deposcoToken, '/orders/purchaseOrders', { number: po.number });
  const isCreate = existing === null;

  // ONE GET: lines already flattened with location + webshopVariantCode + qty + cost + date.
  // (Replaces the old getLines + getLineLocations + 2-calls-per-line resolveWebshopVariantCode.)
  const allLines = await getBmiPurchaseOrderLines(bcCfg, companyId, po.number);

  // Only WMS-tracked item lines: Deposco doesn't fulfill dropship/decoration (non-WMS) or
  // non-item (G/L) lines. Fail-closed — anything else is dropped and logged.
  const isPushable = (l: BmiPoLine): boolean =>
    l.type === 'Item' && WMS_LOCATIONS.has((l.locationCode ?? '').toUpperCase()) && !!l.webshopVariantCode;
  const wmsLines = allLines.filter(isPushable);
  if (wmsLines.length < allLines.length) {
    const dropped = allLines.filter((l) => !isPushable(l))
      .map((l) => `${l.lineNo}:${l.type}/${l.locationCode || '(none)'}${l.webshopVariantCode ? '' : '/noWVC'}`);
    console.log(`[push] ${po.number}: dropped ${dropped.length} non-WMS/non-item line(s): ${dropped.join(', ')}`);
  }
  if (wmsLines.length === 0) {
    console.log(`[push] ${po.number}: 0 WMS line(s) — skipping`);
    return;
  }

  // Split into ≤MAX_PO_LINES chunks (Deposco caps lines per request). Same header
  // (number) on every chunk; lineNumbers are unique (PO line no.), so Deposco
  // upserts/appends them. Only the FIRST chunk of a brand-new PO carries orderStatus.
  const chunks: BmiPoLine[][] = [];
  for (let i = 0; i < wmsLines.length; i += MAX_PO_LINES) {
    chunks.push(wmsLines.slice(i, i + MAX_PO_LINES));
  }
  const multi = chunks.length > 1;

  for (let ci = 0; ci < chunks.length; ci++) {
    const payload = buildDeposcoPayload(po, chunks[ci], isCreate && ci === 0);
    const verb = isCreate && ci === 0 ? 'created' : 'updated';
    const label = multi
      ? `chunk ${ci + 1}/${chunks.length} (${chunks[ci].length} lines, ${verb})`
      : `${wmsLines.length} lines, ${verb}`;
    // postPoChunk lazy-creates any missing items (404) and retries; returns 'skip'
    // when the PO is locked (Partial Receipt) — stop processing further chunks.
    const result = await postPoChunk(bcCfg, deposcoCfg, po, payload, label);
    if (result === 'skip') return;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pull: Deposco receipts → BC (delta-based, idempotent)
// ────────────────────────────────────────────────────────────────────────────

interface ReceiveLine {
  lineId: string;
  label: string;
  quantity: number;
}

async function postReceiveOnly(
  bcCfg: BcConfig,
  companyId: string,
  po: BcPurchaseOrder,
  lines: ReceiveLine[],
): Promise<void> {
  const base = bcApiBase(bcCfg);
  const odata = bcOdataBase(bcCfg);
  const receiptRef = `RCPT-${po.number}-${Date.now()}`;
  let token = await getBcToken(bcCfg);
  await setVendorInvoiceNo(odata, token, po.number, receiptRef);

  console.log(`[pull] ${po.number}: vendor invoice ref = ${receiptRef}`);

  for (const line of lines) {
    token = await getBcToken(bcCfg);
    await patchLine(base, token, companyId, line.lineId, { receiveQuantity: line.quantity });
    token = await getBcToken(bcCfg);
    const r = await patchLine(base, token, companyId, line.lineId, { invoiceQuantity: 0 });
    console.log(`  PATCHed ${po.number} ${line.label}: pending receiveQty=${r['receiveQuantity']} invoiceQty=${r['invoiceQuantity']}`);
  }

  console.log(`[pull] ${po.number}: POST receiveAndInvoice...`);
  token = await getBcToken(bcCfg);
  await postReceiveAndInvoice(base, token, companyId, po.id);

  // Verify BC actually advanced — re-GET lines and show new receivedQuantity / invoicedQuantity.
  // If invoicedQuantity bumped from 0, we accidentally invoiced (would be a bug).
  token = await getBcToken(bcCfg);
  const after = await getLines(base, token, companyId, po.id);
  const afterMap = new Map(after.map((l) => [l.id, l]));
  console.log(`[pull] ${po.number}: BC state after post:`);
  for (const line of lines) {
    const a = afterMap.get(line.lineId);
    if (!a) {
      console.log(`  ${line.label}: line not found in post-state`);
      continue;
    }
    const invStr = (a as { invoicedQuantity?: number }).invoicedQuantity ?? 0;
    const flag = invStr > 0 ? ' ⚠ INVOICED' : '';
    console.log(`  ${line.label}: received=${a.receivedQuantity} invoiced=${invStr}${flag} (posted +${line.quantity})`);
  }
  console.log(`[pull] ${po.number}: ✓ receipt posted (receive-only, ref=${receiptRef})`);
}

async function pullReceiptsForPo(
  bcCfg: BcConfig,
  deposcoCfg: DeposcoConfig,
  companyId: string,
  po: BcPurchaseOrder,
): Promise<void> {
  const base = bcApiBase(bcCfg);
  let bcToken = await getBcToken(bcCfg);
  const bcLines = await getLines(base, bcToken, companyId, po.id);
  const bcLineBySequence = new Map(bcLines.map((l) => [l.sequence, l]));

  const deposcoToken = await getDeposcoToken(deposcoCfg);
  const deposcoOrderId = await lookupDeposcoOrderId(deposcoCfg, deposcoToken, '/orders/purchaseOrders', { number: po.number });
  if (deposcoOrderId === null) {
    console.log(`[pull] ${po.number}: not in Deposco yet, skipping receipt pull`);
    return;
  }
  const receipts = await fetchDeposcoReceipts(deposcoCfg, deposcoToken, deposcoOrderId);
  console.log(`[pull] ${po.number}: Deposco PO ${deposcoOrderId} | bc_lines=${bcLines.length} receipt_events=${receipts.length}`);
  if (bcLines.length === 0) {
    console.warn(`[pull] ${po.number}: ⚠ BC PO has 0 lines — nothing to receive against. Skipping.`);
    return;
  }

  const deposcoQtyBySequence = new Map<number, { item: string; qty: number; rawLineNumbers: Set<string> }>();
  let unparseable = 0;
  for (const r of receipts) {
    const ln = r.orderLine?.businessKey?.lineNumber ?? '';
    const seqStr = ln.split('-').pop();
    const seq = seqStr ? parseInt(seqStr, 10) : NaN;
    if (!Number.isFinite(seq)) {
      console.warn(`  ⚠ unparseable receipt lineNumber: "${ln}" — skipping`);
      unparseable++;
      continue;
    }
    const item = r.receivedItem?.businessKey?.number ?? '?';
    const prev = deposcoQtyBySequence.get(seq);
    const rawLineNumbers = prev?.rawLineNumbers ?? new Set<string>();
    rawLineNumbers.add(ln);
    deposcoQtyBySequence.set(seq, { item, qty: (prev?.qty ?? 0) + r.receivedPackQuantity, rawLineNumbers });
  }

  const bcSeqs = [...bcLineBySequence.keys()].sort((a, b) => a - b);
  const depSeqs = [...deposcoQtyBySequence.keys()].sort((a, b) => a - b);
  console.log(`  bc_sequences=[${bcSeqs.join(',')}]`);
  console.log(`  deposco_mapped_sequences=[${depSeqs.join(',') || '(none)'}]`);

  // Per-line plan: union of (Deposco receipts) and (BC lines).
  const allSequences = new Set<number>([...depSeqs, ...bcSeqs]);
  const toReceive: ReceiveLine[] = [];
  let inSync = 0, bcAhead = 0, noDeposco = 0, orphan = 0;
  for (const seq of [...allSequences].sort((a, b) => a - b)) {
    const dep = deposcoQtyBySequence.get(seq);
    const bcLine = bcLineBySequence.get(seq);
    const depQty = dep?.qty ?? 0;
    const bcQty = bcLine?.receivedQuantity ?? 0;
    const item = dep?.item ?? bcLine?.lineObjectNumber ?? '?';
    if (!bcLine) {
      console.log(`  seq=${seq} item=${item} deposco=${depQty} bc=- ⚠ ORPHAN Deposco receipt (no matching BC line). Raw lineNumbers: ${[...(dep?.rawLineNumbers ?? [])].join(', ')}`);
      orphan++;
      continue;
    }
    if (!dep) {
      console.log(`  seq=${seq} item=${item} deposco=0 bc=${bcQty} — no Deposco receipts on this line`);
      noDeposco++;
      continue;
    }
    const delta = depQty - bcQty;
    const flag = delta > 0 ? '→ POST' : delta === 0 ? '✓ in sync' : 'BC ahead, SKIP';
    console.log(`  seq=${seq} item=${item} deposco=${depQty} bc=${bcQty} delta=${delta} ${flag}`);
    if (delta > 0) {
      toReceive.push({ lineId: bcLine.id, label: `seq${seq}/${bcLine.lineObjectNumber}`, quantity: delta });
    } else if (delta === 0) {
      inSync++;
    } else {
      bcAhead++;
    }
  }

  console.log(`  summary: to_post=${toReceive.length} in_sync=${inSync} bc_ahead=${bcAhead} no_deposco_yet=${noDeposco} orphan=${orphan} unparseable=${unparseable}`);

  if (toReceive.length === 0) {
    const parts: string[] = [];
    if (receipts.length === 0) {
      parts.push('Deposco has no receipt events for this PO yet');
    } else {
      if (inSync > 0) parts.push(`${inSync} line(s) already in sync`);
      if (bcAhead > 0) parts.push(`${bcAhead} line(s) BC-ahead (would need Deposco void to resolve)`);
      if (noDeposco > 0) parts.push(`${noDeposco} BC line(s) have no Deposco receipts yet`);
      if (orphan > 0) parts.push(`⚠ ${orphan} ORPHAN Deposco receipt(s) — line(s) in Deposco that no longer exist in BC (likely renumbered/deleted in BC after receipt posted). Inventory mismatch.`);
      if (unparseable > 0) parts.push(`${unparseable} unparseable receipt lineNumber(s)`);
    }
    console.log(`[pull] ${po.number}: nothing to post — ${parts.join('; ') || 'no actionable state'}`);
    bcToken; // silence unused
    return;
  }
  const total = toReceive.reduce((s, l) => s + l.quantity, 0);
  console.log(`[pull] ${po.number}: posting ${total} units across ${toReceive.length} line(s)`);
  await postReceiveOnly(bcCfg, companyId, po, toReceive);
}

// ────────────────────────────────────────────────────────────────────────────
// Tick + main loop
// ────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function tick(bcCfg: BcConfig, deposcoCfg: DeposcoConfig): Promise<void> {
  const base = bcApiBase(bcCfg);
  const bcToken = await getBcToken(bcCfg);
  const companyId = await getCompanyId(bcCfg, bcToken);

  const pos = await listOpenWspPosAbove(base, bcToken, companyId, PO_THRESHOLD);
  console.log(`[tick] ${pos.length} candidate PO(s) > ${PO_THRESHOLD}: ${pos.map((p) => p.number).join(', ') || '(none)'}`);

  for (const po of pos) {
    try {
      await pushPo(bcCfg, deposcoCfg, companyId, po);
    } catch (err) {
      const e = err as AxiosError;
      console.error(`[push] ${po.number} FAILED HTTP ${e.response?.status}: ${JSON.stringify(e.response?.data ?? e.message).slice(0, 500)}`);
    }
    try {
      const fresh = await getPoByNumber(base, await getBcToken(bcCfg), companyId, po.number);
      if (fresh) await pullReceiptsForPo(bcCfg, deposcoCfg, companyId, fresh);
    } catch (err) {
      const e = err as AxiosError;
      console.error(`[pull] ${po.number} FAILED HTTP ${e.response?.status}: ${JSON.stringify(e.response?.data ?? e.message).slice(0, 500)}`);
    }
  }
}

async function main(): Promise<void> {
  const bcCfg = loadBcConfig();
  const deposcoCfg = loadDeposcoConfig();

  // Single-order mode (web-UI button backend): sync one PO by number.
  // --push-only = BC→Deposco push; --post-only = Deposco→BC receive; default = both.
  const orderIdx = process.argv.indexOf('--order');
  const orderArg = orderIdx >= 0 ? process.argv[orderIdx + 1] : null;
  if (orderArg) {
    const pushOnly = process.argv.includes('--push-only');
    const postOnly = process.argv.includes('--post-only');
    const base = bcApiBase(bcCfg);
    const token = await getBcToken(bcCfg);
    const companyId = await getCompanyId(bcCfg, token);
    const po = await getPoByNumber(base, token, companyId, orderArg);
    if (!po) { console.error(`[sync] ${orderArg}: not found in BC purchaseOrders`); process.exit(1); }
    console.log(`[po] ${orderArg}: ${postOnly ? '' : 'push'}${!pushOnly && !postOnly ? '+' : ''}${pushOnly ? '' : 'receive'}`);
    if (!postOnly) await pushPo(bcCfg, deposcoCfg, companyId, po);
    if (!pushOnly) await pullReceiptsForPo(bcCfg, deposcoCfg, companyId, po);
    return;
  }

  console.log(`[sync] starting — interval=${INTERVAL_MS}ms threshold=${PO_THRESHOLD}`);

  while (true) {
    const t0 = Date.now();
    console.log(`\n[tick] ${new Date().toISOString()} start`);
    try {
      await tick(bcCfg, deposcoCfg);
    } catch (err) {
      console.error('[tick] FAILED:', err instanceof Error ? err.message : err);
    }
    const elapsed = Date.now() - t0;
    console.log(`[tick] done in ${elapsed}ms, sleeping ${Math.max(0, INTERVAL_MS - elapsed)}ms`);
    await sleep(Math.max(0, INTERVAL_MS - elapsed));
  }
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
