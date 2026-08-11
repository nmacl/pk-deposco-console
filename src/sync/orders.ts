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
import type { SyncBcConfig } from './config.js';

export type PostResult = 'ok' | 'skip';

// ── Deposco order reads (shared by po/co/to pulls) ──────────────────────────
// The Deposco side of a pull is identical across doc types — a PO's receipts and a
// CO's shipped-qty come from the same endpoints regardless of whether the source was a
// real PO/SO or a transfer pushed as one. Only the BC write-back differs per doc type.

/** Look up a Deposco order id. endpoint = '/orders/purchaseOrders' (params {number}) or
 *  '/orders/customerOrders' (params {externalOrderNumber}). */
export async function lookupDeposcoOrderId(
  cfg: DeposcoConfig,
  token: string,
  endpoint: string,
  params: Record<string, unknown>,
): Promise<number | null> {
  const body = await authReq<{ data?: Array<{ self?: { id: number } }> }>('get', `${cfg.apiBase}${endpoint}`, token, { params });
  return body.data?.[0]?.self?.id ?? null;
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
export async function fetchReceivedFromPurchaseOrder(cfg: DeposcoConfig, token: string, poId: number): Promise<Array<{ line: number; quantity: number; itemNumber: string | null }>> {
  const d = await authReq<{
    purchaseOrder?: { orderLines?: { data?: Array<{ lineNumber?: string; receivedPackQuantity?: number; item?: { businessKey?: { number?: string } } }> } };
    orderLines?: { data?: Array<{ lineNumber?: string; receivedPackQuantity?: number; item?: { businessKey?: { number?: string } } }> };
  }>('get', `${cfg.apiBase}/orders/purchaseOrders/${poId}`, token);
  const po = d.purchaseOrder ?? d;
  const out: Array<{ line: number; quantity: number; itemNumber: string | null }> = [];
  for (const l of po.orderLines?.data ?? []) {
    const line = parseInt((l.lineNumber ?? '').split('-').pop() ?? '', 10);
    if (Number.isFinite(line)) out.push({ line, quantity: l.receivedPackQuantity ?? 0, itemNumber: l.item?.businessKey?.number ?? null });
  }
  return out;
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
export async function fetchShippedFromFulfillment(cfg: DeposcoConfig, token: string, customerOrderId: number): Promise<DeposcoCoLineShip[]> {
  const co = (await authReq<{ customerOrder?: { fulfillmentOrders?: Array<{ id: number }> } }>('get',
    `${cfg.apiBase}/orders/customerOrders/${customerOrderId}`, token)).customerOrder;
  const out: DeposcoCoLineShip[] = [];
  for (const fo of co?.fulfillmentOrders ?? []) {
    // NOTE: the salesOrder detail comes back at the response ROOT, not wrapped in `salesOrder`
    // (unlike customerOrders/purchaseOrders) — handle both.
    const resp = await authReq<{ salesOrder?: { orderLines?: { data?: SalesOrderLine[] } }; orderLines?: { data?: SalesOrderLine[] } }>('get',
      `${cfg.apiBase}/orders/salesOrders/${fo.id}`, token);
    const so = resp.salesOrder ?? resp;
    for (const l of so?.orderLines?.data ?? []) {
      out.push({ externalLineNumber: l.customerLineNumber, shippedQuantity: l.shippedPackQuantity ?? 0, itemNumber: l.item?.businessKey?.number ?? null });
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

const MAX_ROUNDS = 6;

export async function postDeposcoOrder(
  bcCfg: SyncBcConfig,
  deposcoCfg: DeposcoConfig,
  endpoint: string,     // e.g. '/orders/purchaseOrders' | '/orders/customerOrders'
  payload: unknown,
  logKey: string,       // order number, for logging
  label: string,
): Promise<PostResult> {
  const attempted = new Set<string>();
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
      if (status === 400 && /cannot be updated while in the status of/i.test(msg)) {
        console.log(`[push] ${logKey}: Deposco order in progress, update skipped`);
        return 'skip';
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
