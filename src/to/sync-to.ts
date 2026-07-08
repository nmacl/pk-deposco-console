/**
 * TRANSFER-ORDER sync worker — sibling of po/sync-po.ts and co/sync-co.ts.
 *
 * A Deposco transfer is a CO or a PO by direction (Deposco manages the WMS warehouse):
 *   - Transfer-FROM = WMS → Deposco SHIPS out   → push as a customerOrder, then post the
 *     BC transfer SHIPMENT (Microsoft.NAV.postShipment after PATCHing Qty. to Ship).
 *   - Transfer-TO   = WMS → Deposco RECEIVES in  → push as a purchaseOrder, then post the
 *     BC transfer RECEIPT (Microsoft.NAV.postReceipt after PATCHing Qty. to Receive).
 *   - both (WMS↔WMS) → ship then receive.   - neither → skip.
 *
 * Reuses the shared layer: postDeposcoOrder (lazy-create-retry), bmiTransferOrderLines
 * (flattened lines w/ webshopVariantCode), authReq, createMissingItem. The BC post actions
 * are on our sibling AL extension (al/ bmiTransferOrder) and are validated.
 *
 * Modes:
 *   node dist/to/sync-to.js                          continuous loop (auto batch)
 *   node dist/to/sync-to.js --once                   one tick
 *   node dist/to/sync-to.js --order TRFO001397       sync one TO (push + post) — the
 *                                                    single-order handler the web-UI button calls
 * Gates: TO_PUSH_ENABLED (push to Deposco), TO_POST_ENABLED (post shipment/receipt in BC).
 * A --order run forces both on for that one order.
 *
 * Env: TO_SYNC_INTERVAL_MS (60000), TO_PREFIX (TRFO), TO_PER_TICK (25), TO_WMS_LOCATIONS (WMS),
 *      DEPOSCO_TRADING_PARTNER, DEPOSCO_ORDER_SOURCE, BC_* / DEPOSCO_*.
 */
import 'dotenv/config';
import { type AxiosError } from 'axios';
import { getBcToken } from '../auth.js';
import { getDeposcoToken, type DeposcoConfig } from '../deposco.js';
import { loadBcConfig, loadDeposcoConfig, type SyncBcConfig } from '../sync/config.js';
import { bcOdataBase, bmiApiBase, odataStr, bcGet, pick, numOf, getCompanyId, authReq, type BcRow } from '../sync/bc-client.js';
import { postDeposcoOrder, lookupDeposcoOrderId, fetchReceivedFromPurchaseOrder, fetchShippedFromFulfillment } from '../sync/orders.js';

const INTERVAL_MS = parseInt(process.env.TO_SYNC_INTERVAL_MS ?? '60000', 10);
const PREFIX = process.env.TO_PREFIX ?? 'TRFO';
const PER_TICK = parseInt(process.env.TO_PER_TICK ?? '25', 10);
const PUSH_ENABLED = (process.env.TO_PUSH_ENABLED ?? 'false').toLowerCase() === 'true';
const POST_ENABLED = (process.env.TO_POST_ENABLED ?? 'false').toLowerCase() === 'true';
const BU = process.env.DEPOSCO_COMPANY || 'HIVE';
const TRADING_PARTNER = process.env.DEPOSCO_TRADING_PARTNER || 'CTPK068417';
const ORDER_SOURCE = process.env.DEPOSCO_ORDER_SOURCE ?? 'BusinessCentralOnline';
const WMS_LOCATIONS = new Set((process.env.TO_WMS_LOCATIONS ?? 'WMS').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));

const toDate = (iso: string): string => (iso && iso !== '0001-01-01' ? iso.slice(0, 10) : '');
const toDateTime = (iso: string): string => { const d = toDate(iso); return d ? `${d}T00:00:00Z` : ''; };

// ── BC reads ─────────────────────────────────────────────────────────────────
async function listRecentTransferOrders(odata: string, token: string): Promise<BcRow[]> {
  const filter = encodeURIComponent(`startswith(No,'${odataStr(PREFIX)}')`);
  const url = `${odata}/TransferOrders?$filter=${filter}&$orderby=Posting_Date desc&$top=${PER_TICK}`;
  return (await bcGet<{ value: BcRow[] }>(url, token)).value ?? [];
}

async function getTransferOrder(odata: string, token: string, toNumber: string): Promise<BcRow | null> {
  const url = `${odata}/TransferOrders?$filter=${encodeURIComponent(`No eq '${odataStr(toNumber)}'`)}`;
  return (await bcGet<{ value: BcRow[] }>(url, token)).value?.[0] ?? null;
}

// OData transfer lines — carries @odata.etag + posted quantities, needed for the write-back PATCH.
async function getTransferLines(odata: string, token: string, toNumber: string): Promise<BcRow[]> {
  const url = `${odata}/TransferOrderLines?$filter=${encodeURIComponent(`Document_No eq '${odataStr(toNumber)}'`)}`;
  return (await bcGet<{ value: BcRow[] }>(url, token, { Prefer: 'odata.maxpagesize=5000' })).value ?? [];
}

// Flattened lines from our sibling extension (webshopVariantCode in one GET) — for the Deposco push.
interface BmiToLine { lineNo: number; itemNo: string; webshopVariantCode: string; quantity: number; }
async function getBmiTransferLines(cfg: SyncBcConfig, companyId: string, toNumber: string): Promise<BmiToLine[]> {
  const token = await getBcToken(cfg);
  const filter = encodeURIComponent(`documentNo eq '${odataStr(toNumber)}'`);
  const url = `${bmiApiBase(cfg)}/companies(${companyId})/bmiTransferOrderLines?$filter=${filter}`;
  return (await authReq<{ value: BmiToLine[] }>('get', url, token)).value ?? [];
}

// ── Direction ──────────────────────────────────────────────────────────────
type TransferPlan = 'ship' | 'receive' | 'both' | 'skip';
function classify(header: BcRow): TransferPlan {
  const from = WMS_LOCATIONS.has(pick(header, 'Transfer_from_Code').toUpperCase());
  const to = WMS_LOCATIONS.has(pick(header, 'Transfer_to_Code').toUpperCase());
  if (from && to) return 'both';
  if (from) return 'ship';
  if (to) return 'receive';
  return 'skip';
}

// ── Deposco push payloads (mirror the PO/CO shapes; packQuantity/pack = the Each pack = 1) ──
function pushableLines(lines: BmiToLine[], toNumber: string): BmiToLine[] {
  const ok = lines.filter((l) => !!l.webshopVariantCode && l.quantity > 0);
  const dropped = lines.length - ok.length;
  if (dropped > 0) console.log(`[to] ${toNumber}: dropped ${dropped} line(s) with no WebshopVariantCode / 0 qty`);
  return ok;
}

// receive (into WMS) → Deposco purchaseOrder
function buildTransferAsPurchaseOrder(header: BcRow, lines: BmiToLine[]): unknown {
  const no = pick(header, 'No');
  const orderDate = pick(header, 'Posting_Date', 'Order_Date');
  return {
    businessUnit: { businessKey: { code: BU } },
    number: no,
    orderDate: toDate(orderDate),
    plannedArrivalDate: toDateTime(pick(header, 'Receipt_Date', 'Posting_Date')),
    placedDate: toDateTime(orderDate),
    shipToFacility: { businessKey: { number: BU } },
    orderSource: ORDER_SOURCE,
    orderLines: {
      data: lines.map((l) => ({
        lineNumber: `${no}-${l.lineNo}`,
        item: { businessKey: { number: l.webshopVariantCode, 'businessUnit.code': BU } },
        pack: { businessKey: { 'item.number': l.webshopVariantCode, quantity: 1, 'item.businessUnit.code': BU } },
        orderPackQuantity: l.quantity,
        unitCost: 0,
      })),
    },
  };
}

// A transfer carries no carrier of its own — it fulfills a source sales order (PKSourceNo ==
// Transfer_to_Contact == line SourceNo). Pull the ship-via from that SO, else Deposco parks
// the customerOrder in "in review" ("no ship via with the transfer order").
interface ShipInfo { shipVia: string; shipVendor: string; freightTermsType: string }
async function sourceOrderShipping(odata: string, token: string, sourceNo: string): Promise<ShipInfo | null> {
  if (!sourceNo) return null;
  const so = (await bcGet<{ value: BcRow[] }>(`${odata}/Sales_Order?$filter=${encodeURIComponent(`No eq '${odataStr(sourceNo)}'`)}`, token)).value?.[0];
  if (!so) return null;
  const agent = pick(so, 'Shipping_Agent_Code');
  const service = pick(so, 'Shipping_Agent_Service_Code');
  return {
    shipVendor: agent,
    shipVia: [agent, service].filter(Boolean).join(' '),
    freightTermsType: pick(so, 'LAX_Shipping_Payment_Type') || 'Prepaid',
  };
}

// ship (out of WMS) → Deposco customerOrder; ship-to is the transfer destination location,
// ship-via comes from the source sales order (see sourceOrderShipping).
function buildTransferAsCustomerOrder(header: BcRow, lines: BmiToLine[], ship: ShipInfo | null): unknown {
  const no = pick(header, 'No');
  const name = pick(header, 'Transfer_to_Name') || pick(header, 'Transfer_to_Code');
  const parts = name.split(/\s+/);
  return {
    customerOrder: {
      businessUnit: { businessKey: { code: BU } },
      tradingPartner: { businessKey: { code: TRADING_PARTNER, 'businessUnit.code': BU } },
      primarySalesChannel: { businessKey: { code: BU } },
      externalOrderNumber: no,
      orderSource: ORDER_SOURCE,
      placedDate: toDateTime(pick(header, 'Posting_Date', 'Order_Date')),
      ...(ship ? { shipVia: ship.shipVia, shipVendor: ship.shipVendor, freightTermsType: ship.freightTermsType } : {}),
      shipToContact: {
        attention: pick(header, 'Transfer_to_Contact', 'Transfer_to_Name'),
        firstName: parts[0] || name || 'N/A',
        lastName: parts.slice(1).join(' ') || parts[0] || 'N/A',
        line1: pick(header, 'Transfer_to_Address'),
        line2: pick(header, 'Transfer_to_Address_2'),
        city: pick(header, 'Transfer_to_City'),
        stateProvince: pick(header, 'Transfer_to_County'),
        postalCode: pick(header, 'Transfer_to_Post_Code'),
        country: pick(header, 'Trsf_to_Country_Region_Code') || 'US',
      },
      channels: [],
      coLines: {
        data: lines.map((l) => ({
          externalLineNumber: String(l.lineNo),
          itemNumber: l.webshopVariantCode,
          orderQuantity: l.quantity,
          packQuantity: 1,
        })),
      },
    },
  };
}

// Skip a customerOrder push if Deposco already has one (CO POST doesn't upsert — it dupes).
async function customerOrderExists(deposcoCfg: DeposcoConfig, externalOrderNumber: string): Promise<boolean> {
  const token = await getDeposcoToken(deposcoCfg);
  const body = await authReq<{ data?: unknown[] }>('get',
    `${deposcoCfg.apiBase}/orders/customerOrders`, token, { params: { externalOrderNumber } });
  return (body.data?.length ?? 0) > 0;
}

async function pushTransfer(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, companyId: string, header: BcRow, plan: TransferPlan): Promise<void> {
  const no = pick(header, 'No');
  const asWhat = plan === 'receive' ? 'purchaseOrder' : plan === 'ship' ? 'customerOrder' : 'purchaseOrder + customerOrder';
  console.log(`[push] ${no}: reading BC transfer lines (bmiTransferOrderLines) → Deposco as ${asWhat}`);
  const lines = pushableLines(await getBmiTransferLines(cfg, companyId, no), no);
  if (lines.length === 0) { console.log(`[push] ${no}: 0 pushable line(s) — skipping`); return; }
  for (const l of lines) console.log(`  L${l.lineNo} item=${l.itemNo} → ${l.webshopVariantCode} qty=${l.quantity}`);

  if (plan === 'receive' || plan === 'both') {
    await postDeposcoOrder(cfg, deposcoCfg, '/orders/purchaseOrders', buildTransferAsPurchaseOrder(header, lines), no, `${lines.length} line(s) as PO (receive)`);
  }
  if (plan === 'ship' || plan === 'both') {
    if (await customerOrderExists(deposcoCfg, no)) {
      console.log(`[push] ${no}: customerOrder already in Deposco — skipping create (no upsert)`);
    } else {
      // ship-via comes from the source SO (PKSourceNo == Transfer_to_Contact == line SourceNo).
      const sourceNo = pick(header, 'PKSourceNo', 'Transfer_to_Contact');
      const ship = await sourceOrderShipping(bcOdataBase(cfg), await getBcToken(cfg), sourceNo);
      if (!ship) console.warn(`[push] ${no}: no source SO shipping found (source=${sourceNo || 'none'}) — CO may land in review`);
      await postDeposcoOrder(cfg, deposcoCfg, '/orders/customerOrders', buildTransferAsCustomerOrder(header, lines, ship), no, `${lines.length} line(s) as CO (ship)${ship ? `, via ${ship.shipVia}` : ''}`);
    }
  }
}


// ── Pull Deposco → BC: post the shipment and/or receipt to match what Deposco confirmed ──
// The bmi post actions are always available; we just post the leg(s) needed:
//   receive (X→WMS): Deposco RECEIVED it → post the origin shipment (into transit) AND the receipt.
//   ship    (WMS→X): Deposco SHIPPED it  → post the shipment; a DIRECT transfer also receives.
// Direct = all-or-nothing (BC requires the full line qty); non-direct = post the delta.

// Resolve the TO's SystemId on the bmi page and POST the bound ship/receive action.
async function bmiPost(cfg: SyncBcConfig, companyId: string, no: string, action: 'postShipment' | 'postReceipt', token: string): Promise<void> {
  const bmi = `${bmiApiBase(cfg)}/companies(${companyId})`;
  const order = (await authReq<{ value: Array<{ systemId: string }> }>('get',
    `${bmi}/bmiTransferOrders?$filter=${encodeURIComponent(`no eq '${odataStr(no)}'`)}`, token)).value?.[0];
  if (!order) { console.warn(`[pull] ${no}: not on bmiTransferOrders page — cannot ${action}`); return; }
  const doc = await authReq<string>('post', `${bmi}/bmiTransferOrders(${order.systemId})/Microsoft.NAV.${action}`, token, { data: {} });
  const posted = typeof doc === 'object' && doc && 'value' in (doc as Record<string, unknown>) ? (doc as { value: unknown }).value : doc;
  console.log(`[pull] ${no}: ✅ ${action} → BC doc ${JSON.stringify(posted)}`);
}

// Post one leg: PATCH each line's qty up to the Deposco-confirmed target, then fire the action.
async function postLeg(cfg: SyncBcConfig, companyId: string, no: string, action: 'postShipment' | 'postReceipt', qtyField: 'Qty_to_Ship' | 'Qty_to_Receive', postedField: 'Quantity_Shipped' | 'Quantity_Received', confirmed: Map<number, number>, direct: boolean): Promise<void> {
  const odata = bcOdataBase(cfg);
  const token = await getBcToken(cfg);
  const lines = await getTransferLines(odata, token, no);
  let staged = 0;
  for (const l of lines) {
    const ln = numOf(l, 'Line_No');
    const dep = confirmed.get(ln) ?? 0;
    const posted = numOf(l, postedField);
    const qty = numOf(l, 'Quantity');
    let toPost: number;
    if (direct) {
      if (posted >= qty) continue;
      if (dep < qty) { console.log(`  L${ln} ${pick(l, 'Item_No')}: direct — Deposco ${dep}/${qty}, waiting for full qty`); continue; }
      toPost = qty - posted;
    } else {
      toPost = dep - posted;
      if (toPost <= 0) continue;
    }
    await authReq('patch', `${odata}/TransferOrderLines(Document_No='${odataStr(no)}',Line_No=${ln})`, token,
      { data: { [qtyField]: toPost }, headers: { 'If-Match': String(l['@odata.etag'] ?? '*') } });
    console.log(`  L${ln} ${pick(l, 'Item_No')}: deposco=${dep} bc=${posted} → ${qtyField} += ${toPost}`);
    staged += toPost;
  }
  if (staged === 0) { console.log(`[pull] ${no}: ${action} — nothing to post (in sync)`); return; }
  console.log(`[pull] ${no}: ${action} — staged ${staged} unit(s)`);
  await bmiPost(cfg, companyId, no, action, token);
}

async function pull(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, companyId: string, header: BcRow, plan: TransferPlan, direct: boolean): Promise<void> {
  const no = pick(header, 'No');
  const dToken = await getDeposcoToken(deposcoCfg);

  if (plan === 'receive' || plan === 'both') {
    const poId = await lookupDeposcoOrderId(deposcoCfg, dToken, '/orders/purchaseOrders', { number: no });
    if (poId === null) { console.log(`[pull] ${no}: not in Deposco (purchaseOrder) yet — skip receive`); return; }
    const recv = new Map<number, number>();
    for (const r of await fetchReceivedFromPurchaseOrder(deposcoCfg, dToken, poId)) recv.set(r.line, (recv.get(r.line) ?? 0) + r.quantity);
    console.log(`[pull] ${no}: RECEIVE — Deposco received ${[...recv].map(([k, v]) => `L${k}=${v}`).join(' ') || '(none)'}`);
    // Origin doesn't post its own shipment, so post it (→ in transit) then receive — both to the received qty.
    await postLeg(cfg, companyId, no, 'postShipment', 'Qty_to_Ship', 'Quantity_Shipped', recv, direct);
    await postLeg(cfg, companyId, no, 'postReceipt', 'Qty_to_Receive', 'Quantity_Received', recv, direct);
  } else if (plan === 'ship') {
    const coId = await lookupDeposcoOrderId(deposcoCfg, dToken, '/orders/customerOrders', { externalOrderNumber: no });
    if (coId === null) { console.log(`[pull] ${no}: not in Deposco (customerOrder) yet — skip ship`); return; }
    const shipped = new Map<number, number>();
    for (const l of await fetchShippedFromFulfillment(deposcoCfg, dToken, coId)) {
      const ln = parseInt(l.externalLineNumber ?? '', 10);
      if (Number.isFinite(ln)) shipped.set(ln, (shipped.get(ln) ?? 0) + Number(l.shippedQuantity ?? 0));
    }
    console.log(`[pull] ${no}: SHIP — Deposco shipped ${[...shipped].map(([k, v]) => `L${k}=${v}`).join(' ') || '(none)'}${direct ? ' (direct → ship+receive)' : ''}`);
    await postLeg(cfg, companyId, no, 'postShipment', 'Qty_to_Ship', 'Quantity_Shipped', shipped, direct);
    if (direct) await postLeg(cfg, companyId, no, 'postReceipt', 'Qty_to_Receive', 'Quantity_Received', shipped, direct);
  }
}

// ── Single-order sync (the web-UI button backend) + batch tick ──────────────
async function syncOne(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, companyId: string, header: BcRow, opts: { push: boolean; post: boolean }): Promise<void> {
  const no = pick(header, 'No');
  const from = pick(header, 'Transfer_from_Code').toUpperCase();
  const to = pick(header, 'Transfer_to_Code').toUpperCase();
  const plan = classify(header);
  if (plan === 'skip') { console.log(`[to] ${no}: ${from}→${to} not WMS-relevant — skip`); return; }
  const direct = pick(header, 'Direct_Transfer') === 'true';
  console.log(`[to] ${no}: ${from}→${to} → ${plan}${direct ? ' (direct)' : ''}`);

  if (opts.push) await pushTransfer(cfg, deposcoCfg, companyId, header, plan);
  if (opts.post) await pull(cfg, deposcoCfg, companyId, header, plan, direct);
}


async function tick(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig): Promise<void> {
  const odata = bcOdataBase(cfg);
  const token = await getBcToken(cfg);
  const companyId = await getCompanyId(cfg, token);
  let orders: BcRow[];
  try {
    orders = await listRecentTransferOrders(odata, token);
  } catch (err) {
    console.error(`[tick] list FAILED: ${(err as AxiosError).response?.status ?? (err as Error).message}`);
    return;
  }
  console.log(`[tick] ${orders.length} transfer order(s)`);
  for (const header of orders) {
    try {
      await syncOne(cfg, deposcoCfg, companyId, header, { push: PUSH_ENABLED, post: POST_ENABLED });
    } catch (err) {
      const e = err as AxiosError;
      console.error(`[to] ${pick(header, 'No')} FAILED HTTP ${e.response?.status}: ${JSON.stringify(e.response?.data ?? e.message).slice(0, 400)}`);
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadBcConfig();
  const deposcoCfg = loadDeposcoConfig();
  const orderIdx = process.argv.indexOf('--order');
  const orderArg = orderIdx >= 0 ? process.argv[orderIdx + 1] : null;

  // Single-order manual sync (web-UI button backend). Defaults to push + post; --push-only
  // / --post-only isolate the two halves (separate "sync to Deposco" vs "ship/receive" buttons).
  if (orderArg) {
    const pushOnly = process.argv.includes('--push-only');
    const postOnly = process.argv.includes('--post-only');
    const token = await getBcToken(cfg);
    const companyId = await getCompanyId(cfg, token);
    const header = await getTransferOrder(bcOdataBase(cfg), token, orderArg);
    if (!header) { console.error(`[to] ${orderArg}: not found`); process.exit(1); }
    await syncOne(cfg, deposcoCfg, companyId, header, { push: !postOnly, post: !pushOnly });
    return;
  }

  const once = process.argv.includes('--once');
  console.log(`[to-sync] starting — interval=${INTERVAL_MS}ms prefix=${PREFIX} perTick=${PER_TICK} push=${PUSH_ENABLED} post=${POST_ENABLED} wms=[${[...WMS_LOCATIONS].join(',')}]${once ? ' (single tick)' : ''}`);
  if (once) { await tick(cfg, deposcoCfg); return; }
  for (;;) {
    const t0 = Date.now();
    try { await tick(cfg, deposcoCfg); } catch (err) { console.error('[tick] FAILED:', err instanceof Error ? err.message : err); }
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t0)));
  }
}

main().catch((err) => { console.error('FATAL:', err instanceof Error ? err.message : err); process.exit(1); });
