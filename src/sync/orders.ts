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
import { authReq } from './bc-client.js';
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
      if (status === 400 && /cannot be updated while in the status of/i.test(msg)) {
        console.log(`[push] ${logKey}: Deposco order in progress, update skipped`);
        return 'skip';
      }
      if (status === 404) {
        const all = parseMissingItemNumbers(errs);
        if (all.length === 0) throw err; // 404 but not an item-missing error
        const todo = all.filter((n) => !attempted.has(n));
        if (todo.length === 0) {
          console.error(`[push] ${logKey}: missing item(s) ${all.join(', ')} could not be created — giving up`);
          return 'skip';
        }
        console.log(`[push] ${logKey}: ${todo.length} missing item(s) → lazy-creating: ${todo.join(', ')}`);
        for (const n of todo) { attempted.add(n); await createMissingItem(bcCfg, deposcoCfg, n); }
        continue;
      }
      throw err;
    }
  }
  console.error(`[push] ${logKey}: exceeded lazy-create retries for ${label}`);
  return 'skip';
}
