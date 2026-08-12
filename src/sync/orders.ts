/**
 * Shared Deposco order POST with lazy-create-on-404 retry — the loop that po (postPoChunk),
 * co (postSo), and to all need. On 400 "cannot be updated while in the status of" → skip
 * (the warehouse is already working the order). On 404 missing-item → createMissingItem for
 * each referenced item and retry (up to MAX_ROUNDS).
 */
import axios, { type AxiosError } from 'axios';
import { ipv4Agent } from '../auth.js';
import { getDeposcoToken, type DeposcoConfig } from '../deposco.js';
import { createMissingItem, parseMissingItemNumbers } from './items.js';
import { authReq, deposcoThrottle } from './bc-client.js';
import { logEvent, dailyDedupe } from './db-log.js';
import type { SyncBcConfig } from './config.js';

export type PostResult = 'ok' | 'skip';

// ── Deposco order reads (shared by po/co/to pulls) ──────────────────────────
// The Deposco side of a pull is identical across doc types — a PO's receipts and a
// CO's shipped-qty come from the same endpoints regardless of whether the source was a
// real PO/SO or a transfer pushed as one. Only the BC write-back differs per doc type.

/**
 * Deposco returns nested collections as { data, links, complete, pages } and caps `data` at TEN
 * rows. There is NO way to reach rows 11+: the `links` array comes back empty, the sub-resource
 * path (…/{id}/coLines) 404s, and every pagination param we tried (page / offset / start / size /
 * limit / pageSize / maxResults / count) is SILENTLY IGNORED — the same response comes back every
 * time. Worse, page 1 is an arbitrary subset, not the first 10 by line number (SO320 returned
 * lines 110000,100000,…,120000,30000 and withheld 10000/20000).
 *
 * So for any order over 10 lines we cannot see the whole thing, and anything that reads a nested
 * collection must say so rather than treat 10-of-24 as the full picture. `complete === false`
 * (or pages > 1) is the flag. Callers post what they CAN see and log a desync naming the order,
 * so a partially-posted shipment is visible instead of silently permanent.
 */
const nestedTruncated = (c: { complete?: boolean | null; pages?: number | null } | undefined): boolean =>
  c?.complete === false || (c?.pages ?? 1) > 1;

/**
 * Read an order's lines from the SUB-RESOURCE (…/{id}/orderLines) and walk it to the end.
 *
 * This is the escape hatch from the 10-row nested cap. The sub-resource is a proper paged
 * collection — 25 rows a page with a working links[].rel='next' — so following `next` yields the
 * whole set: WSP32262 gives 82 lines over 4 pages where the nested copy showed 10 of 9 "pages".
 * Both order types support it; note the path is `/orderLines` on salesOrders AND purchaseOrders,
 * while `/coLines` on customerOrders 404s.
 *
 * `complete` is false only if we bailed on maxPages — running out of `next` links means we
 * genuinely reached the end.
 */
async function fetchLinesPaged<T>(cfg: DeposcoConfig, token: string, path: string, maxPages = 40): Promise<{ rows: T[]; complete: boolean }> {
  interface Page { data?: T[]; links?: Array<{ rel?: string; href?: string }>; complete?: boolean | null }
  const rows: T[] = [];
  let url = `${cfg.apiBase}${path}`;
  for (let page = 0; page < maxPages; page++) {
    const body = await authReq<Page>('get', url, token);
    rows.push(...(body.data ?? []));
    if (body.complete) return { rows, complete: true };
    const next = body.links?.find((l) => l.rel === 'next')?.href;
    if (!next) return { rows, complete: true };
    url = next;
  }
  console.warn(`[deposco] ${path}: stopped after ${maxPages} pages — line list may be incomplete`);
  return { rows, complete: false };
}

/** Look up a Deposco order id. endpoint = '/orders/purchaseOrders' (params {number}) or
 *  '/orders/customerOrders' (params {externalOrderNumber}). */
interface DsOrderRef { self?: { id?: number }; number?: string; status?: string; orderStatus?: string }

const isCancelled = (r: DsOrderRef): boolean =>
  /cancel/i.test(String(r.status ?? r.orderStatus ?? ''));

export async function lookupDeposcoOrderId(
  cfg: DeposcoConfig,
  token: string,
  endpoint: string,
  params: Record<string, unknown>,
  opts: { liveOnly?: boolean } = {},
): Promise<number | null> {
  const body = await authReq<{ data?: DsOrderRef[] }>('get', `${cfg.apiBase}${endpoint}`, token, { params });
  const rows = body.data ?? [];
  if (rows.length === 0) return null;

  // Deposco returns copies NEWEST FIRST, and taking data[0] blindly resolved the wrong record
  // once the duplicate cleanup ran: DISO211239 had 18 copies where the newest 17 were Canceled
  // and only the OLDEST (CO1, Complete, 9 units shipped) was real. The pull read the cancelled
  // one, saw shippedTotal=0, concluded "nothing to post", and BC never got its shipment.
  //
  // Prefer a LIVE order — and when several are live, the OLDEST, which is the canonical copy the
  // cleanup convention keeps. Fall back to the newest cancelled one rather than null so the
  // push's existence check still reports "exists" and cannot start recreating in a loop; a
  // cancelled order legitimately has nothing to ship, so the pull correctly does nothing.
  const live = rows.filter((r) => !isCancelled(r));
  // liveOnly is for the PUSH existence check: "is there an order worth not duplicating?".
  // Without it, an order whose every copy has been cancelled reports as still present, so the
  // push skips forever and the order can NEVER be re-created — which is exactly the remediation
  // path for a bad push (cancel in Deposco, let the connector send a clean one). Seen on
  // DISO210970, whose CO landed with unlinked item lines and could not be replaced.
  if (opts.liveOnly && live.length === 0) {
    if (rows.length > 0) console.log(`[lookup] ${endpoint} ${JSON.stringify(params)}: ${rows.length} copy/copies, ALL cancelled — treating as absent so a fresh one can be pushed`);
    return null;
  }
  const chosen = live.length > 0 ? live[live.length - 1] : rows[0];
  if (rows.length > 1) {
    console.log(`[lookup] ${endpoint} ${JSON.stringify(params)}: ${rows.length} copies (${rows.length - live.length} cancelled) — using id=${chosen.self?.id} ${JSON.stringify(chosen.status ?? chosen.orderStatus ?? null)}`);
  }
  return chosen.self?.id ?? null;
}

export interface DeposcoReceipt {
  receivedItem: { businessKey: { number: string } };
  receivedPackQuantity: number;
  orderLine: { businessKey: { lineNumber: string } };
}
interface DeposcoReceiptsPage { data?: DeposcoReceipt[]; links?: Array<{ rel?: string; href?: string }>; complete?: boolean }

/** Paged /receipts for a Deposco order (purchaseOrder or transfer-as-PO). */
export async function fetchDeposcoReceipts(cfg: DeposcoConfig, token: string, orderId: number): Promise<DeposcoReceipt[]> {
  const MAX_PAGES = 200;
  const all: DeposcoReceipt[] = [];
  let url = `${cfg.apiBase}/receipts`;
  let params: Record<string, unknown> | undefined = { orderId };
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await authReq<DeposcoReceiptsPage>('get', url, token, { params });
    if (body.data) all.push(...body.data);
    if (body.complete) break;
    const next = body.links?.find((l) => l.rel === 'next')?.href;
    if (!next) break;
    url = next;
    params = undefined;
  }
  return all;
}

/**
 * Cumulative received qty per line straight off the purchaseOrder's order lines
 * (`receivedPackQuantity`), keyed by the line-number suffix (`TRFO001458-20000` → 20000 ==
 * BC Line_No). This is the reliable source — the `/receipts` events log can be empty even
 * when the line shows received qty (mirrors shipped qty living on the child SO, not the CO
 * rollup). Returns { line, quantity } pairs.
 */
export interface ReceivedResult {
  lines: Array<{ line: number; quantity: number; itemNumber: string | null }>;
  /** True when Deposco withheld some order lines (see nestedTruncated) — the caller must not
   *  treat what it got as the whole order. */
  truncated: boolean;
}

export async function fetchReceivedFromPurchaseOrder(cfg: DeposcoConfig, token: string, poId: number): Promise<ReceivedResult> {
  interface PoLine { lineNumber?: string; receivedPackQuantity?: number; item?: { businessKey?: { number?: string } } }
  interface PoLines { data?: PoLine[]; complete?: boolean | null; pages?: number | null }

  // Sub-resource, walked to the end — the purchaseOrder detail's nested `orderLines` is capped at
  // 10 with no reachable page 2, so reading it under-reports received quantity on any PO over 10
  // lines and BC would be left short with nothing to show for it (WSP32262: 10 nested vs 82 real).
  const paged = await fetchLinesPaged<PoLine>(cfg, token, `/orders/purchaseOrders/${poId}/orderLines`);
  let rows = paged.rows;
  let complete = paged.complete;

  // Degrade to the nested copy rather than lose the pull entirely if the sub-resource ever stops
  // answering; it still reports truncation so a short read can't pass as a full one.
  if (rows.length === 0) {
    const d = await authReq<{ purchaseOrder?: { orderLines?: PoLines }; orderLines?: PoLines }>(
      'get', `${cfg.apiBase}/orders/purchaseOrders/${poId}`, token);
    const po = d.purchaseOrder ?? d;
    rows = po.orderLines?.data ?? [];
    complete = !nestedTruncated(po.orderLines);
  }

  const lines: ReceivedResult['lines'] = [];
  for (const l of rows) {
    const line = parseInt((l.lineNumber ?? '').split('-').pop() ?? '', 10);
    if (Number.isFinite(line)) lines.push({ line, quantity: l.receivedPackQuantity ?? 0, itemNumber: l.item?.businessKey?.number ?? null });
  }
  return { lines, truncated: !complete };
}

export interface DeposcoCoLineShip { externalLineNumber?: string; shippedQuantity?: number; itemNumber?: string | null }

interface SalesOrderLine { customerLineNumber?: string; shippedPackQuantity?: number; item?: { businessKey?: { number?: string } } }

/**
 * The real shipment truth for a customerOrder: Deposco spawns a child salesOrder (fulfillment
 * order) per CO that does the allocate/pick/ship, and the shipped qty lives on ITS lines as
 * `shippedPackQuantity` (the CO's coLines only roll up at completion). Walk the CO's
 * fulfillmentOrders → each child salesOrder's lines, keyed back by `customerLineNumber`
 * (== the CO externalLineNumber == BC Line_No). Returns the same shape as
 * fetchCustomerOrderShipped so it's a drop-in for the ship pull.
 */
export interface ShippedResult {
  lines: DeposcoCoLineShip[];
  /** Fulfillment orders whose line list Deposco truncated (see nestedTruncated). Non-empty means
   *  some shipped lines are UNREADABLE, so posting only what we saw under-ships BC. */
  truncatedOrders: string[];
}

export async function fetchShippedFromFulfillment(cfg: DeposcoConfig, token: string, customerOrderId: number): Promise<ShippedResult> {
  interface SoLines { data?: SalesOrderLine[]; complete?: boolean | null; pages?: number | null }
  const co = (await authReq<{ customerOrder?: { fulfillmentOrders?: Array<{ id: number }> } }>('get',
    `${cfg.apiBase}/orders/customerOrders/${customerOrderId}`, token)).customerOrder;
  const lines: DeposcoCoLineShip[] = [];
  const truncatedOrders: string[] = [];
  for (const fo of co?.fulfillmentOrders ?? []) {
    // Read the lines from the SUB-RESOURCE, walked to the end — not from the order detail's
    // nested `orderLines`. The nested copy is capped at 10 rows with no reachable page 2 (see
    // nestedTruncated), which silently under-reports any order over 10 lines: SO320 showed 10
    // lines / 28 units nested, but 12 lines / 36 units here — BC would have been short 8 units
    // and nothing would have said so.
    // NOTE it is `/orderLines` on salesOrders; the equivalent `/coLines` on customerOrders 404s.
    const paged = await fetchLinesPaged<SalesOrderLine>(cfg, token, `/orders/salesOrders/${fo.id}/orderLines`);
    let rows = paged.rows;
    let complete = paged.complete;

    // Fall back to the order detail if the sub-resource ever stops answering, so a Deposco-side
    // change degrades to the old (truncating) behaviour rather than losing the pull entirely.
    if (rows.length === 0) {
      const resp = await authReq<{ salesOrder?: { number?: string; orderLines?: SoLines }; number?: string; orderLines?: SoLines }>('get',
        `${cfg.apiBase}/orders/salesOrders/${fo.id}`, token);
      const so = resp.salesOrder ?? resp;
      rows = so?.orderLines?.data ?? [];
      complete = !nestedTruncated(so?.orderLines);
    }

    for (const l of rows) {
      lines.push({ externalLineNumber: l.customerLineNumber, shippedQuantity: l.shippedPackQuantity ?? 0, itemNumber: l.item?.businessKey?.number ?? null });
    }
    if (!complete) {
      const label = `SO id ${fo.id}`;
      truncatedOrders.push(label);
      console.warn(`[deposco] fulfillment ${label}: only ${rows.length} line(s) readable and the set is incomplete — the rest are UNREADABLE via the API`);
    }
  }
  return { lines, truncatedOrders };
}

/**
 * Post-push audit of a customerOrder.
 *
 * `POST /orders/customerOrders` does NOT reject an unknown item the way the PO endpoint does —
 * there is no 404 "Item with business key number = [X]", so the lazy-create in postDeposcoOrder
 * never fires. Instead Deposco returns 201 and quietly writes the line with `item: {id: null,
 * businessKey: null}` and `packQuantity: null`. The order then sits in Review, unpickable, while
 * our log says "pushed to Deposco / ok".
 *
 * Seen live on DISO210970: lines 13000 (ME0EK01S-IRON-MD) and 17000 (ME0EK01S-IRON-3XL) landed
 * unlinked because those two items were absent from Deposco — their UPCs had been bound to the
 * retired "OLD Iron" (…-IRN-…) items by the go-live catalog load, so the creates 400'd on
 * "UPC … exists for item …" and nobody saw it.
 *
 * So: read the order back, find lines whose item did not resolve, and lazy-create those items so
 * the NEXT push is clean. The order already written cannot be repaired — Deposco has no PATCH on
 * a customerOrder (405) and no coLines sub-resource (404) — so the caller must surface this as a
 * desync for a human to cancel + re-push.
 *
 * `intended` maps externalLineNumber -> the item number we asked for, which is the only way to
 * know what an unlinked line was SUPPOSED to be (Deposco keeps no record of the rejected value).
 */
export interface PushAudit {
  orderId: number;
  checked: number;
  truncated: boolean;
  unlinked: Array<{ externalLineNumber: string; itemNumber: string; quantity: number }>;
  created: string[];
}

export async function auditPushedCustomerOrder(
  bcCfg: SyncBcConfig,
  deposcoCfg: DeposcoConfig,
  token: string,
  externalOrderNumber: string,
  intended: Map<string, string>,
): Promise<PushAudit | null> {
  interface CoLine { externalLineNumber?: string; orderQuantity?: number; item?: { businessKey?: { number?: string } | null } | null }
  interface CoLines { data?: CoLine[]; complete?: boolean | null; pages?: number | null }
  // The push returns 202 Accepted, NOT 201 — Deposco creates the customerOrder ASYNCHRONOUSLY,
  // so an immediate read-back races it and finds nothing (verified on DISO211157: the POST
  // returned 202, the lookup came back empty, and CO407 existed moments later). Poll briefly
  // rather than reporting a healthy order as unverifiable.
  let id: number | null = null;
  for (let attempt = 1; attempt <= AUDIT_LOOKUP_ATTEMPTS; attempt++) {
    id = await lookupDeposcoOrderId(deposcoCfg, token, '/orders/customerOrders', { externalOrderNumber }, { liveOnly: true });
    if (id !== null) break;
    if (attempt < AUDIT_LOOKUP_ATTEMPTS) await new Promise((r) => setTimeout(r, AUDIT_LOOKUP_DELAY_MS));
  }
  if (id === null) {
    console.warn(`[audit] ${externalOrderNumber}: order not visible in Deposco after ${AUDIT_LOOKUP_ATTEMPTS} attempts — cannot verify the push landed cleanly`);
    return null;
  }
  const resp = await authReq<{ customerOrder?: { coLines?: CoLines } }>('get', `${deposcoCfg.apiBase}/orders/customerOrders/${id}`, token);
  const coLines = resp.customerOrder?.coLines;
  const rows = coLines?.data ?? [];
  const unlinked: PushAudit['unlinked'] = [];
  for (const l of rows) {
    if (l.item?.businessKey?.number) continue;
    const ext = String(l.externalLineNumber ?? '');
    unlinked.push({ externalLineNumber: ext, itemNumber: intended.get(ext) ?? '(unknown)', quantity: l.orderQuantity ?? 0 });
  }
  // Create what's missing so the re-push succeeds. Deduped: several lines can want one item.
  const created: string[] = [];
  for (const n of new Set(unlinked.map((u) => u.itemNumber).filter((n) => n && n !== '(unknown)'))) {
    if (await createMissingItem(bcCfg, deposcoCfg, n)) created.push(n);
  }
  return { orderId: id, checked: rows.length, truncated: nestedTruncated(coLines), unlinked, created };
}

/**
 * Every outbound shipment Deposco has, newest first.
 *
 * This inverts the shipment pull. Driving it from BC meant walking ~1,278 open orders and asking
 * Deposco "did this ship?" about each — ~3,800 calls a lap against an ACCOUNT-WIDE 4/sec ceiling,
 * nearly all of them answered "no". Deposco will just tell us instead: the whole shipment history
 * is 109 records over 3 pages (2026-08-12), each carrying `orderHeaders` -> the fulfillment
 * salesOrder, plus its tracking number. Three calls replaces the entire sweep.
 *
 * Unlike the nested collections (coLines etc., capped at 10 with no reachable page 2), this is a
 * TOP-LEVEL list and paginates properly via links[].rel='next' with a real searchId cursor — so
 * following `next` genuinely walks the whole set.
 *
 * `number` is sequential (1..125 so far), which makes it a safe numeric high-water mark — the
 * same discipline BC selection uses. NOTE the query params are ignored, exactly like
 * `?salesOrderNumber=` on shipments and `?upc=` on items: actualShipDateFrom / shipDateFrom /
 * updatedDateFrom / status were all tried and every one returned the identical first page. So
 * filtering MUST happen client-side on what comes back, never by asking the API to filter.
 */
export interface OutboundShipmentRef {
  number: number;
  salesOrderIds: number[];
  trackingNumber: string;
  status: string;
  updatedDate: string;
}

export async function fetchOutboundShipments(cfg: DeposcoConfig, token: string, maxPages = 20): Promise<OutboundShipmentRef[]> {
  interface Row { number?: string | number; trackingNumber?: string; status?: string; updatedDate?: string; orderHeaders?: { data?: Array<{ id?: number }> } }
  interface Page { data?: Row[]; links?: Array<{ rel?: string; href?: string }>; complete?: boolean }
  const out: OutboundShipmentRef[] = [];
  let url = `${cfg.apiBase}/shipments/outboundShipments`;
  for (let page = 0; page < maxPages; page++) {
    const body = await authReq<Page>('get', url, token);
    for (const r of body.data ?? []) {
      const n = Number(r.number);
      if (!Number.isFinite(n)) continue;
      out.push({
        number: n,
        salesOrderIds: (r.orderHeaders?.data ?? []).map((o) => o.id).filter((i): i is number => typeof i === 'number'),
        trackingNumber: (r.trackingNumber ?? '').trim(),
        status: r.status ?? '',
        updatedDate: r.updatedDate ?? '',
      });
    }
    if (body.complete) break;
    const next = body.links?.find((l) => l.rel === 'next')?.href;
    if (!next) break;
    url = next;
  }
  return out;
}

/** Fulfillment salesOrder id -> the BC order number it fulfills (`customerOrderNumber` sits right
 *  on the salesOrder, so this is one hop, no customerOrder lookup needed). */
export async function resolveCustomerOrderNumbers(cfg: DeposcoConfig, token: string, salesOrderIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const id of new Set(salesOrderIds)) {
    try {
      const r = await authReq<{ salesOrder?: { customerOrderNumber?: string }; customerOrderNumber?: string }>(
        'get', `${cfg.apiBase}/orders/salesOrders/${id}`, token);
      const num = (r.salesOrder ?? r).customerOrderNumber;
      if (num) out.set(id, num);
    } catch (err) {
      console.warn(`[shipments] salesOrder ${id}: could not resolve customerOrderNumber — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

export interface DeposcoTrackingLine {
  bcLineNo: number;        // customerLineNumber == BC Sales_Order_Line.Line_No
  itemNumber: string;
  quantity: number;        // shippedPackQuantity on THIS tracking number
}

export interface DeposcoTracking {
  shipmentNo: string;      // Deposco outbound shipment number (e.g. '205')
  salesOrderNo: string;    // Deposco fulfillment order (e.g. 'SO12502')
  trackingNumber: string;
  trackingUrl: string;     // full link (Deposco returns a BASE url; number appended here)
  carrier: string;         // shipVendor — already 'FedEx' / 'UPS'
  shipVia: string;
  shipMethod: string;
  containerLpn: string;
  totalPackages: number;
  totalWeight: number;
  actualShipDate: string | null;
  /** Units actually on this label. Deposco emits shipments with a tracking number and ZERO
   *  quantity (a label created then not used) — those must not be treated as the primary
   *  tracking number, so callers filter on this. */
  shippedUnits: number;
  lines: DeposcoTrackingLine[];
}

interface DsShipmentRef { id?: number }
interface DsOutboundShipment {
  number?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shipVendor?: string;
  shipVia?: string;
  shipMethod?: string;
  lpnNumber?: string;
  totalPackages?: number;
  // Deposco returns weights as { value, units } — NOT a bare number. Sending the object
  // straight through made BC reject the POST with "Cannot convert a value to target type
  // 'Edm.Decimal'". Tolerate both shapes.
  totalWeight?: number | { value?: number; units?: string };
  shipmentDates?: { actualShipDate?: string };
  shippedContainers?: { data?: Array<{ lpnNumber?: string }> };
  shipmentLines?: { data?: DsShipmentLine[] };
}

interface DsShipmentLine {
  shippedPackQuantity?: number;
  externalLineNumber?: string;
  orderLine?: { id?: number };
  item?: { businessKey?: { number?: string } };
}

/**
 * Tracking for a Deposco fulfillment order (salesOrder).
 *
 * Walk salesOrder → shipments[] → GET /shipments/outboundShipments/{id}. Two traps this
 * deliberately avoids:
 *   1. the `href` on salesOrder.shipments[] points at the TRIP (…/{id}/trip), not the shipment —
 *      so the URL is rebuilt from the ref's `id`;
 *   2. `?salesOrderNumber=` is SILENTLY IGNORED by the API — it returns some other order's
 *      shipment. Never filter that way; a wrong tracking number on a real order is worse than
 *      none. Navigate by id only.
 */
export async function fetchTrackingForSalesOrder(
  cfg: DeposcoConfig,
  token: string,
  salesOrderId: number,
): Promise<DeposcoTracking[]> {
  interface DsOrderLine { self?: { id?: number }; customerLineNumber?: string }
  interface DsSalesOrder { number?: string; shipments?: { data?: DsShipmentRef[] }; orderLines?: { data?: DsOrderLine[] } }
  const so = await authReq<{ salesOrder?: DsSalesOrder } & DsSalesOrder>(
    'get', `${cfg.apiBase}/orders/salesOrders/${salesOrderId}`, token);
  const root = so.salesOrder ?? so;

  // orderLine id -> customerLineNumber (== BC Sales_Order_Line.Line_No). The shipmentLine's own
  // externalLineNumber is often blank, so this map is the reliable route back to the BC line.
  const lineNoById = new Map<number, number>();
  for (const l of root.orderLines?.data ?? []) {
    const n = parseInt(l.customerLineNumber ?? '', 10);
    if (l.self?.id !== undefined && Number.isFinite(n)) lineNoById.set(l.self.id, n);
  }

  const out: DeposcoTracking[] = [];
  for (const ref of root.shipments?.data ?? []) {
    if (ref.id === undefined) continue;
    const d = await authReq<{ outboundShipment?: DsOutboundShipment } & DsOutboundShipment>(
      'get', `${cfg.apiBase}/shipments/outboundShipments/${ref.id}`, token);
    const s = d.outboundShipment ?? d;
    const num = (s.trackingNumber ?? '').trim();
    if (!num) continue;                       // picked/packed but not yet labelled
    const baseUrl = (s.trackingUrl ?? '').trim();
    const lines: DeposcoTrackingLine[] = [];
    for (const sl of s.shipmentLines?.data ?? []) {
      const fromMap = sl.orderLine?.id !== undefined ? lineNoById.get(sl.orderLine.id) : undefined;
      const bcLineNo = fromMap ?? parseInt(sl.externalLineNumber ?? '', 10);
      if (!Number.isFinite(bcLineNo)) continue;
      lines.push({
        bcLineNo: bcLineNo as number,
        itemNumber: sl.item?.businessKey?.number ?? '',
        quantity: sl.shippedPackQuantity ?? 0,
      });
    }
    out.push({
      shipmentNo: String(s.number ?? ref.id),
      salesOrderNo: root.number ?? '',
      trackingNumber: num,
      trackingUrl: baseUrl ? `${baseUrl}${num}` : '',
      carrier: (s.shipVendor ?? '').trim(),
      shipVia: (s.shipVia ?? '').trim(),
      shipMethod: (s.shipMethod ?? '').trim(),
      containerLpn: (s.shippedContainers?.data?.[0]?.lpnNumber ?? s.lpnNumber ?? '').trim(),
      totalPackages: s.totalPackages ?? 0,
      shippedUnits: lines.reduce((n, l) => n + l.quantity, 0),
      lines,
      totalWeight: typeof s.totalWeight === 'number' ? s.totalWeight : (s.totalWeight?.value ?? 0),
      actualShipDate: s.shipmentDates?.actualShipDate ?? null,
    });
  }
  return out;
}

/**
 * Deposco reports field-length violations in a machine-readable form:
 *   "customerOrder.shipToContact.lastName size must be between 0 and 30"
 * We've hit this twice on launch day (email 50, lastName 30) and each time it 400'd the WHOLE
 * order over one cosmetic field. Rather than discover every limit by losing orders, parse the
 * path + limit, truncate that one string in the payload, and retry.
 *
 * Returns a description of what it trimmed, or null if the message wasn't a size violation or
 * the path didn't resolve to an over-long string (in which case the caller must not retry).
 */
function trimOversizeField(payload: unknown, msg: string): { path: string; limit: number; from: number } | null {
  const m = msg.match(/([A-Za-z0-9_.]+)\s+size must be between\s+\d+\s+and\s+(\d+)/i);
  if (!m) return null;
  const limit = parseInt(m[2], 10);
  if (!Number.isFinite(limit) || limit < 0) return null;

  // Walk the dotted path, tolerating the wrapper ("customerOrder.x" vs a bare "x" payload).
  const walk = (root: unknown, segs: string[]): { obj: Record<string, unknown>; key: string } | null => {
    let cur: unknown = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = (cur as Record<string, unknown>)[segs[i]];
    }
    if (cur == null || typeof cur !== 'object') return null;
    return { obj: cur as Record<string, unknown>, key: segs[segs.length - 1] };
  };

  const segs = m[1].split('.');
  const target = walk(payload, segs) ?? (segs.length > 1 ? walk(payload, segs.slice(1)) : null);
  if (!target) return null;
  const val = target.obj[target.key];
  if (typeof val !== 'string' || val.length <= limit) return null;
  target.obj[target.key] = val.slice(0, limit).trim();
  return { path: m[1], limit, from: val.length };
}

// Deposco accepts a customerOrder with 202 and materializes it asynchronously, so the read-back
// audit has to wait for it to appear. ~8s of headroom in total.
const AUDIT_LOOKUP_ATTEMPTS = parseInt(process.env.DEPOSCO_AUDIT_ATTEMPTS ?? '5', 10);
const AUDIT_LOOKUP_DELAY_MS = parseInt(process.env.DEPOSCO_AUDIT_DELAY_MS ?? '2000', 10);

// 429 retries for the order POST, budgeted separately from MAX_ROUNDS so a rate limit never eats
// the lazy-create rounds. Matches authReq's DEPOSCO_RATE_LIMIT_ATTEMPTS default.
const RATE_LIMIT_RETRIES = parseInt(process.env.DEPOSCO_RATE_LIMIT_ATTEMPTS ?? '8', 10);
// Deposco optimistic-lock conflicts (409 "updated by a concurrent request"). Budgeted apart from
// MAX_ROUNDS so a busy resource never eats the lazy-create rounds.
const CONFLICT_RETRIES = parseInt(process.env.DEPOSCO_CONFLICT_ATTEMPTS ?? '6', 10);

const MAX_ROUNDS = 6;
// Known-good orderSource to fall back to if Deposco rejects a programme code.
const ORDER_SOURCE_FALLBACK = process.env.DEPOSCO_ORDER_SOURCE ?? 'BusinessCentralOnline';

export async function postDeposcoOrder(
  bcCfg: SyncBcConfig,
  deposcoCfg: DeposcoConfig,
  endpoint: string,     // e.g. '/orders/purchaseOrders' | '/orders/customerOrders'
  payload: unknown,
  logKey: string,       // order number, for logging
  label: string,
  opts: { worker?: string; runId?: number | null } = {},
): Promise<PostResult> {
  const attempted = new Set<string>();
  let sourceRetried = false;
  let sizeTrims = 0;
  let rateLimited = 0;
  let conflicts = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    try {
      const token = await getDeposcoToken(deposcoCfg);
      await deposcoThrottle();
      const resp = await axios.post(`${deposcoCfg.apiBase}${endpoint}`, payload, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        httpsAgent: ipv4Agent, timeout: 30_000,
      });
      console.log(`[push] ${logKey} → Deposco HTTP ${resp.status} (${label})`);
      return 'ok';
    } catch (err) {
      const axErr = err as AxiosError<{ errors?: Array<{ errorMessage?: string }> }>;
      const status = axErr.response?.status;
      const errs = axErr.response?.data?.errors;
      const msg = errs?.[0]?.errorMessage ?? '';
      // Verbose-always (global): surface method + endpoint + status + body, so a CO/PO push
      // failure never collapses to a bare "Request failed with status code 400".
      const verbose = new Error(`POST ${endpoint} [${logKey}] → HTTP ${status ?? axErr.code ?? '?'}: ${(typeof axErr.response?.data === 'string' ? axErr.response.data : JSON.stringify(axErr.response?.data ?? axErr.message)).slice(0, 600)}`);
      // Rate limit. This POST goes through raw axios rather than authReq, so it does NOT inherit
      // authReq's 429 budget — a rate-limited push was simply DROPPED, and Deposco's limit is
      // account-wide (4/sec) while each worker process throttles independently, so bursts are
      // routine: TRFO001663/1667 and DISO210961/211101 were all lost inside 21 seconds on
      // 2026-08-12. A 429 means the request was REJECTED, never processed, so re-sending is
      // always safe — and it must not consume a lazy-create round, hence the separate budget and
      // the `round--`.
      if (status === 429 && rateLimited < RATE_LIMIT_RETRIES) {
        rateLimited++;
        const retryAfter = Number(axErr.response?.headers?.['retry-after']);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** (rateLimited - 1), 20_000) + Math.floor(Math.random() * 500);
        console.log(`[push] ${logKey}: Deposco rate limit — retry ${rateLimited}/${RATE_LIMIT_RETRIES} in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        round--;
        continue;
      }
      // Concurrency conflict: "The resource was updated by a concurrent request. Please retry
      // when the resource is not in use." Deposco's optimistic lock — something else (the
      // warehouse UI, another worker, their own async processing) touched the order between our
      // read and our write. Like a 429 and like a SQL deadlock, the write was REJECTED, not
      // half-applied, so re-sending is safe; and the order POST is an upsert keyed on the order
      // number, so a retry cannot duplicate. Seen on WSP32638.
      if (status === 409 && /concurrent request|not in use/i.test(msg) && conflicts < CONFLICT_RETRIES) {
        conflicts++;
        // Short, randomised: whatever held the resource is usually done in moments, and a fixed
        // wait would just collide with the other writer again.
        const waitMs = 400 * 2 ** (conflicts - 1) + Math.floor(Math.random() * 600);
        console.log(`[push] ${logKey}: Deposco resource busy — retry ${conflicts}/${CONFLICT_RETRIES} in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        round--;
        continue;
      }
      if (status === 400 && /cannot be updated while in the status of/i.test(msg)) {
        console.log(`[push] ${logKey}: Deposco order in progress, update skipped`);
        return 'skip';
      }
      // orderSource is now the BC ProgramID (THDMET / DI / WBB / …). It is UNCONFIRMED whether
      // Deposco validates orderSource against a fixed set — if it does, a programme code would
      // 400 and kill the push entirely. Retry ONCE with the known-good value rather than lose
      // the order, and log loudly so the mapping can be fixed properly.
      if (status === 400 && /order\s*source/i.test(msg) && !sourceRetried) {
        const p = payload as { orderSource?: string; customerOrder?: { orderSource?: string } };
        const target = p.customerOrder ?? p;
        const rejected = target.orderSource;
        if (rejected && rejected !== ORDER_SOURCE_FALLBACK) {
          const warn = `Deposco rejected orderSource '${rejected}' — retried with '${ORDER_SOURCE_FALLBACK}'. orderSource looks like a validated set; the ProgramID needs Deposco-side config.`;
          console.error(`[push] ${logKey}: ⚠ ${warn} (${msg.slice(0, 140)})`);
          // Surface it in the DB too — the push SUCCEEDS after the retry, so without this row
          // the degraded orderSource would be invisible to anyone reading sync_events.
          await logEvent({
            runId: opts.runId ?? null, worker: opts.worker ?? 'push', direction: 'bc->deposco',
            entityType: 'order', entityId: logKey, action: 'push', status: 'desync', side: 'deposco',
            message: warn, detail: { rejectedOrderSource: rejected, fallback: ORDER_SOURCE_FALLBACK, deposcoMessage: msg.slice(0, 300), endpoint },
            dedupeKey: dailyDedupe('order-source', logKey, rejected),
          });
          target.orderSource = ORDER_SOURCE_FALLBACK;
          sourceRetried = true;
          continue;
        }
      }
      // Field too long -> trim that ONE field and retry, rather than losing the order over it.
      if (status === 400 && /size must be between/i.test(msg) && sizeTrims < 6) {
        const trimmed = trimOversizeField(payload, msg);
        if (trimmed) {
          sizeTrims++;
          const warn = `field ${trimmed.path} was ${trimmed.from} chars, over Deposco's ${trimmed.limit} — truncated and retried`;
          console.warn(`[push] ${logKey}: ⚠ ${warn}`);
          await logEvent({
            runId: opts.runId ?? null, worker: opts.worker ?? 'push', direction: 'bc->deposco',
            entityType: 'order', entityId: logKey, action: 'push', status: 'desync', side: 'deposco',
            message: warn, detail: { field: trimmed.path, limit: trimmed.limit, originalLength: trimmed.from, endpoint },
            dedupeKey: dailyDedupe('field-size', logKey, trimmed.path),
          });
          continue;
        }
      }
      if (status === 404) {
        const all = parseMissingItemNumbers(errs);
        if (all.length === 0) throw verbose; // 404 but not an item-missing error
        const todo = all.filter((n) => !attempted.has(n));
        if (todo.length === 0) {
          console.error(`[push] ${logKey}: missing item(s) ${all.join(', ')} could not be created — giving up`);
          return 'skip';
        }
        console.log(`[push] ${logKey}: ${todo.length} missing item(s) → lazy-creating: ${todo.join(', ')}`);
        for (const n of todo) { attempted.add(n); await createMissingItem(bcCfg, deposcoCfg, n); }
        continue;
      }
      throw verbose;
    }
  }
  console.error(`[push] ${logKey}: exceeded lazy-create retries for ${label}`);
  return 'skip';
}
