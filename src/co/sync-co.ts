/**
 * Long-running CUSTOMER-ORDER sync worker — sibling of po/sync.ts (the PO monolith).
 * Deploy as its own worker process. (Sourced from BC sales orders; pushed to Deposco
 * as customerOrders — the Deposco entity is a customerOrder, not a salesOrder.)
 *
 * Every SO_SYNC_INTERVAL_MS:
 *   1. For each SO prefix (PKSO/WSOD/HDSO/DISO), list the most recent N BC sales orders.
 *   2. For each SO:
 *      - Push BC → Deposco: POST /orders/customerOrders (wrapped { customerOrder: {...} }
 *        payload — unlike salesOrders/purchaseOrders). On a 404 missing-item, lazy-create
 *        from BC and retry. On a 400 "in progress", skip (warehouse already working it).
 *      - Pull Deposco → BC (shipment confirmation): IMPLEMENTED, gated behind
 *        SO_PULL_ENABLED (default false). Reads coLines[].shippedQuantity off the CO
 *        detail (no /shipments endpoint exists), deltas vs BC cumulative shippedQuantity
 *        per line, and posts SHIP-ONLY via Microsoft.NAV.shipAndInvoice (invoiceQuantity=0,
 *        the PO receive-only mirror). Tracking-number write-back is a later add. NOTE:
 *        External Document No. handling (setExternalDocumentNo) needs verifying live.
 *
 * Modeled on the proven build-co.mjs (push) + po/sync.ts (worker loop + lazy item create).
 * Item-create machinery is duplicated from po/sync.ts on purpose: two standalone monoliths
 * now, factor into shared modules later.
 *
 * Env:
 *   SO_SYNC_INTERVAL_MS  (default 60000)                   — sleep between ticks
 *   SO_PREFIXES          (default "PKSO,WSOD,HDSO,DISO")   — BC SO number prefixes to sync
 *   SO_PER_PREFIX        (default 25)                      — most-recent N per prefix per tick
 *   SO_PULL_ENABLED      (default false)                   — enable the shipment pull (ship-only)
 *   BC_*                 BC auth + environment + company
 *   DEPOSCO_*            Deposco auth + env + company
 */
import 'dotenv/config';
import { type AxiosError } from 'axios';
import { getBcToken } from '../auth.js';
import { getDeposcoToken, type DeposcoConfig } from '../deposco.js';
import { loadBcConfig, loadDeposcoConfig, type SyncBcConfig } from '../sync/config.js';
import { bcApiBase, bcOdataBase, odataStr, bcGet, pick, numOf, getCompanyId, authReq, type BcRow } from '../sync/bc-client.js';
import { postDeposcoOrder, lookupDeposcoOrderId, fetchShippedFromFulfillment } from '../sync/orders.js';

// local alias kept so existing signatures below read unchanged
type BcConfig = SyncBcConfig;

const INTERVAL_MS = parseInt(process.env.SO_SYNC_INTERVAL_MS ?? '60000', 10);
const PREFIXES = (process.env.SO_PREFIXES ?? 'PKSO,WSOD,HDSO,DISO').split(',').map((p) => p.trim()).filter(Boolean);
const PER_PREFIX = parseInt(process.env.SO_PER_PREFIX ?? '25', 10);
const PULL_ENABLED = (process.env.SO_PULL_ENABLED ?? 'false').toLowerCase() === 'true';
const BU = process.env.DEPOSCO_COMPANY || 'HIVE';
const ORDER_SOURCE = process.env.DEPOSCO_ORDER_SOURCE ?? 'BusinessCentralOnline';
// Deposco trading partner all COs attach to (hardcoded for now; per-customer mapping later).
const TRADING_PARTNER = process.env.DEPOSCO_TRADING_PARTNER || 'CTPK068417';
// Only push SO lines whose BC Location_Code is a WMS-tracked warehouse (default WMS only).
// Non-WMS lines (PK / DROPSHIP / decoration / on-demand like ODENTIRE, ODTAGSWAG) are
// skipped — Deposco doesn't fulfill them.
const WMS_LOCATIONS = new Set((process.env.SO_WMS_LOCATIONS ?? 'WMS').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));

// ────────────────────────────────────────────────────────────────────────────
// BC fetch (custom OData pages — Sales_Order / Sales_Order_Line)
// Config + bcGet/pick/numOf/odataStr/bcApiBase/bcOdataBase/getCompanyId now live in ../sync/*.
// ────────────────────────────────────────────────────────────────────────────

async function listRecentSos(odata: string, token: string, prefix: string, count: number): Promise<BcRow[]> {
  const filter = encodeURIComponent(`startswith(No,'${odataStr(prefix)}')`);
  const url = `${odata}/Sales_Order?$filter=${filter}&$orderby=Order_Date desc&$top=${count}`;
  const body = await bcGet<{ value: BcRow[] }>(url, token);
  return body.value ?? [];
}

async function getSoLines(odata: string, token: string, soNumber: string): Promise<BcRow[]> {
  const filter = encodeURIComponent(`Document_No eq '${odataStr(soNumber)}'`);
  const url = `${odata}/Sales_Order_Line?$filter=${filter}`;
  const body = await bcGet<{ value: BcRow[] }>(url, token, { Prefer: 'odata.maxpagesize=5000' });
  // Item lines only, and only those stocked at a WMS location.
  return (body.value ?? []).filter((l) => pick(l, 'Type') === 'Item' && WMS_LOCATIONS.has(pick(l, 'Location_Code').toUpperCase()));
}

// ────────────────────────────────────────────────────────────────────────────
// Payload builders (ported from build-so.mjs — nested-businessKey REST shape)
// ────────────────────────────────────────────────────────────────────────────

const toDate = (v: string): string => (v && v !== '0001-01-01' ? v.slice(0, 10) : '');
const toDateTime = (v: string): string => { const d = toDate(v); return d ? `${d}T00:00:00Z` : ''; };

// customerOrder.shipToContact is FLAT — address fields live inside the contact.
interface DeposcoShipToContact {
  attention: string; firstName: string; lastName: string;
  line1: string; line2: string; city: string; stateProvince: string; postalCode: string; country: string;
  phone: string; email: string;
}
function shipToContact(h: BcRow): DeposcoShipToContact {
  const name = pick(h, 'Ship_to_Name').trim();
  const parts = name.split(/\s+/);
  return {
    attention: pick(h, 'Ship_to_Contact', 'Ship_to_Name'),
    firstName: parts[0] || name || 'N/A',
    lastName: parts.slice(1).join(' ') || parts[0] || 'N/A',
    line1: pick(h, 'Ship_to_Address'),
    line2: pick(h, 'Ship_to_Address_2'),
    city: pick(h, 'Ship_to_City'),
    stateProvince: pick(h, 'Ship_to_County', 'Ship_to_State'),
    postalCode: pick(h, 'Ship_to_Post_Code'),
    country: pick(h, 'Ship_to_Country_Region_Code', 'Ship_to_Country_Code') || 'US',
    phone: pick(h, 'Ship_to_Phone_No', 'Sell_to_Phone_No'),
    email: pick(h, 'Sell_to_E_Mail'),
  };
}

interface DeposcoCoLine {
  externalLineNumber: string;
  itemNumber: string;
  orderQuantity: number;
  packQuantity: number;
  unitPrice: number;
}

// Wrapped customerOrder payload — validated against PILOT (created CO2412). The wrapper
// is REQUIRED (unlike salesOrders/purchaseOrders); EntityRefs for businessUnit/tradingPartner/
// primarySalesChannel; coLines use flat itemNumber + orderQuantity/packQuantity.
interface DeposcoCustomerOrderPayload {
  customerOrder: {
    businessUnit: { businessKey: { code: string } };
    tradingPartner: { businessKey: { code: string; 'businessUnit.code': string } };
    primarySalesChannel: { businessKey: { code: string } };
    externalOrderNumber: string;
    orderSource: string;
    placedDate: string;
    shipVia?: string;
    shipVendor?: string;
    freightTermsType?: string;
    shipToContact: DeposcoShipToContact;
    channels: unknown[];
    coLines: { data: DeposcoCoLine[] };
  };
}

// Ship-via comes straight off the SO header (unlike TO, which borrows it from a source SO).
// Without it Deposco parks the customerOrder "in review" with a blank ship via.
// PK's shipping runs on the E-Ship (LAX_*) fields, so we source from those — the combined
// LAX_E_Ship_Agent_Service code (e.g. "FEDEX_GROUND") is exactly what the E-Ship Agent
// Service box shows on the order, NOT the standard Shipping_Agent_Service_Code ("GROUND").
interface ShipInfo { shipVia: string; shipVendor: string; freightTermsType: string }
function headerShipping(header: BcRow): ShipInfo | null {
  const service = pick(header, 'LAX_E_Ship_Agent_Service');
  const agent = pick(header, 'LAX_Shipping_Agent_Code', 'Shipping_Agent_Code');
  if (!service && !agent) return null;
  return {
    shipVia: service || agent,
    shipVendor: agent,
    freightTermsType: pick(header, 'LAX_Shipping_Payment_Type') || 'Prepaid',
  };
}

function buildCustomerOrder(header: BcRow, rawLines: BcRow[]): DeposcoCustomerOrderPayload {
  const soNumber = pick(header, 'No');
  const ship = headerShipping(header);
  const data: DeposcoCoLine[] = rawLines.map((l) => {
    const num = pick(l, 'WebshopVariantCode', 'No');
    const qty = numOf(l, 'Quantity');
    // externalLineNumber = BC Sales_Order_Line Line_No (unique within the SO) so the
    // shipment pull can map Deposco coLine.shippedQuantity back to the BC line. Was a
    // synthetic 1..N index, which couldn't be reconciled to BC.
    // packQuantity is the PACK size (the item's Each pack = 1), NOT the order qty — mirrors
    // the PO side (orderPackQuantity=qty against the quantity-1 Each pack). Default 1 on every line.
    return { externalLineNumber: pick(l, 'Line_No'), itemNumber: num, orderQuantity: qty, packQuantity: 1, unitPrice: numOf(l, 'Unit_Price', 'Unit_Price_LCY') };
  });
  return {
    customerOrder: {
      businessUnit: { businessKey: { code: BU } },
      tradingPartner: { businessKey: { code: TRADING_PARTNER, 'businessUnit.code': BU } },
      primarySalesChannel: { businessKey: { code: BU } },
      externalOrderNumber: soNumber,
      orderSource: ORDER_SOURCE,
      placedDate: toDateTime(pick(header, 'Order_Date', 'Document_Date')),
      ...(ship ? { shipVia: ship.shipVia, shipVendor: ship.shipVendor, freightTermsType: ship.freightTermsType } : {}),
      shipToContact: shipToContact(header),
      channels: [],
      coLines: { data },
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Lazy item creation (duplicated from po/sync.ts — factor out later)
// ────────────────────────────────────────────────────────────────────────────

// Lazy item creation (buildDeposcoItem/parseMissingItemNumbers/createMissingItem)
// now lives in ../sync/items.ts, shared with po/to.

// ────────────────────────────────────────────────────────────────────────────
// Push: BC SO → Deposco  (POST /orders/salesOrders, lazy-create on 404, skip if locked)
// ────────────────────────────────────────────────────────────────────────────

type PostResult = 'ok' | 'skip';

// Find an existing Deposco CO for this BC SO — filters on `externalOrderNumber` (the BC SO
// number we stamp on push; Deposco's own `number` is CO2835 and won't match ours).
const lookupCustomerOrderId = (deposcoCfg: DeposcoConfig, token: string, externalOrderNumber: string) =>
  lookupDeposcoOrderId(deposcoCfg, token, '/orders/customerOrders', { externalOrderNumber });

async function postSo(bcCfg: BcConfig, deposcoCfg: DeposcoConfig, soNumber: string, payload: DeposcoCustomerOrderPayload, label: string): Promise<PostResult> {
  return postDeposcoOrder(bcCfg, deposcoCfg, '/orders/customerOrders', payload, soNumber, label);
}

async function pushSo(bcCfg: BcConfig, deposcoCfg: DeposcoConfig, header: BcRow): Promise<void> {
  const odata = bcOdataBase(bcCfg);
  const soNumber = pick(header, 'No');
  const bcToken = await getBcToken(bcCfg);
  const lines = await getSoLines(odata, bcToken, soNumber);
  if (lines.length === 0) {
    console.log(`[push] ${soNumber}: 0 item lines — skipping`);
    return;
  }
  // customerOrders POST does NOT upsert — it creates a brand-new CO every time, so the
  // per-tick re-push was minting duplicate Deposco orders. Skip if one already exists.
  // (Updating an existing CO on SO edits is a follow-up — needs Deposco update-by-id.)
  const dToken = await getDeposcoToken(deposcoCfg);
  const existing = await lookupCustomerOrderId(deposcoCfg, dToken, soNumber);
  if (existing !== null) {
    console.log(`[push] ${soNumber}: already in Deposco (CO id ${existing}) — skipping create (no upsert yet)`);
    return;
  }
  const payload = buildCustomerOrder(header, lines);
  const via = payload.customerOrder.shipVia;
  if (!via) console.warn(`[push] ${soNumber}: ⚠ no ship-via on SO header — CO may land in review`);
  await postSo(bcCfg, deposcoCfg, soNumber, payload, `${lines.length} WMS line(s)${via ? `, via ${via}` : ''}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Pull: Deposco shipment confirmation → BC  (gated behind SO_PULL_ENABLED)
// ────────────────────────────────────────────────────────────────────────────
//
// Deposco has NO /shipments endpoint — shipment state is inline on the CO detail:
// GET /orders/customerOrders/{id} → coLines[].shippedQuantity (cumulative), keyed by
// externalLineNumber (== BC Sales_Order_Line.Line_No, which the push now stamps). We
// delta that against BC's cumulative shippedQuantity per line and post a ship-only via
// Microsoft.NAV.shipAndInvoice (invoiceQuantity=0) — the direct mirror of the PO
// receive-only pull. Tracking-number write-back is a later add (the fulfillmentOrders
// shape only materializes once a CO actually ships; nothing in PILOT has shipped yet).

interface BcSalesOrder { id: string; number: string; status: string; }
interface BcSalesOrderLine {
  id: string;
  sequence: number; // == Sales_Order_Line.Line_No == Deposco externalLineNumber
  lineObjectNumber: string;
  quantity: number;
  shippedQuantity: number; // cumulative posted shipments (read-only)
  invoicedQuantity?: number;
}

async function getSalesOrderByNumber(base: string, token: string, companyId: string, soNumber: string): Promise<BcSalesOrder | null> {
  const body = await authReq<{ value: BcSalesOrder[] }>('get',
    `${base}/companies(${companyId})/salesOrders?$filter=${encodeURIComponent(`number eq '${soNumber}'`)}`, token);
  return body.value[0] ?? null;
}

async function getSalesLines(base: string, token: string, companyId: string, soId: string): Promise<BcSalesOrderLine[]> {
  const body = await authReq<{ value: BcSalesOrderLine[] }>('get',
    `${base}/companies(${companyId})/salesOrders(${soId})/salesOrderLines`, token);
  return body.value;
}

async function patchSalesLine(base: string, token: string, companyId: string, lineId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return authReq<Record<string, unknown>>('patch',
    `${base}/companies(${companyId})/salesOrderLines(${lineId})`, token,
    { data: body, headers: { 'If-Match': '*' } });
}

async function postShipAndInvoice(base: string, token: string, companyId: string, soId: string): Promise<void> {
  await authReq('post',
    `${base}/companies(${companyId})/salesOrders(${soId})/Microsoft.NAV.shipAndInvoice`, token, { data: {} });
}

// External Document No. is the sales analog of the PO's mandatory Vendor_Invoice_No. If
// Sales & Receivables Setup has "Ext. Doc. No. Mandatory" on, shipAndInvoice rejects a
// blank one — the same trap the PO side hit. Set a unique ref via OData before posting.
// VERIFY the field/key names against this instance before flipping SO_PULL_ENABLED on.
async function setExternalDocumentNo(odata: string, token: string, soNumber: string, ref: string): Promise<void> {
  const body = await authReq<{ value: Array<{ '@odata.etag': string }> }>('get',
    `${odata}/Sales_Order?$filter=No eq '${odataStr(soNumber)}'`, token);
  const so = body.value[0];
  if (!so) throw new Error(`SO ${soNumber} not found via ODataV4`);
  await authReq('patch',
    `${odata}/Sales_Order(Document_Type='Order',No='${odataStr(soNumber)}')`, token,
    { data: { External_Document_No: ref }, headers: { 'If-Match': so['@odata.etag'] } });
}

interface ShipLine { lineId: string; label: string; quantity: number }

async function pullShipmentsForSo(bcCfg: BcConfig, deposcoCfg: DeposcoConfig, soNumber: string): Promise<void> {
  const dToken = await getDeposcoToken(deposcoCfg);
  const orderId = await lookupCustomerOrderId(deposcoCfg, dToken, soNumber);
  if (orderId === null) {
    console.log(`[pull] ${soNumber}: not in Deposco yet, skipping shipment pull`);
    return;
  }

  // Aggregate Deposco shipped qty by BC Line_No (externalLineNumber == Line_No).
  const coLines = await fetchShippedFromFulfillment(deposcoCfg, dToken, orderId);
  const shippedByLineNo = new Map<number, { item: string; qty: number }>();
  let unparseable = 0;
  for (const l of coLines) {
    const lineNo = parseInt(l.externalLineNumber ?? '', 10);
    if (!Number.isFinite(lineNo)) {
      if ((l.shippedQuantity ?? 0) > 0) { console.warn(`  ⚠ shipped qty on unparseable externalLineNumber "${l.externalLineNumber}" — skipping`); unparseable++; }
      continue;
    }
    const prev = shippedByLineNo.get(lineNo);
    shippedByLineNo.set(lineNo, { item: l.itemNumber ?? prev?.item ?? '?', qty: (prev?.qty ?? 0) + Number(l.shippedQuantity ?? 0) });
  }

  const base = bcApiBase(bcCfg);
  let bcToken = await getBcToken(bcCfg);
  const companyId = await getCompanyId(bcCfg, bcToken);
  const so = await getSalesOrderByNumber(base, bcToken, companyId, soNumber);
  if (!so) {
    console.log(`[pull] ${soNumber}: not found via BC v2.0 salesOrders, skipping`);
    return;
  }
  const bcLines = await getSalesLines(base, bcToken, companyId, so.id);
  const bcByLineNo = new Map(bcLines.map((l) => [l.sequence, l]));
  console.log(`[pull] ${soNumber}: Deposco CO ${orderId} | bc_lines=${bcLines.length} deposco_lines=${coLines.length}`);
  if (bcLines.length === 0) {
    console.warn(`[pull] ${soNumber}: ⚠ BC SO has 0 lines — nothing to ship against. Skipping.`);
    return;
  }

  // Per-line plan: union of (Deposco shipped) and (BC lines), delta = deposco − bc.
  const toShip: ShipLine[] = [];
  let inSync = 0, bcAhead = 0, noDeposco = 0, orphan = 0;
  for (const ln of [...new Set<number>([...shippedByLineNo.keys(), ...bcByLineNo.keys()])].sort((a, b) => a - b)) {
    const dep = shippedByLineNo.get(ln);
    const bcLine = bcByLineNo.get(ln);
    const depQty = dep?.qty ?? 0;
    const bcQty = bcLine?.shippedQuantity ?? 0;
    const item = dep?.item ?? bcLine?.lineObjectNumber ?? '?';
    if (!bcLine) {
      console.log(`  line=${ln} item=${item} deposco=${depQty} bc=- ⚠ ORPHAN Deposco line (no matching BC line)`);
      orphan++;
      continue;
    }
    if (!dep) { noDeposco++; continue; }
    const delta = depQty - bcQty;
    const flag = delta > 0 ? '→ SHIP' : delta === 0 ? '✓ in sync' : 'BC ahead, SKIP';
    console.log(`  line=${ln} item=${item} deposco=${depQty} bc=${bcQty} delta=${delta} ${flag}`);
    if (delta > 0) toShip.push({ lineId: bcLine.id, label: `line${ln}/${bcLine.lineObjectNumber}`, quantity: delta });
    else if (delta === 0) inSync++;
    else bcAhead++;
  }
  console.log(`  summary: to_ship=${toShip.length} in_sync=${inSync} bc_ahead=${bcAhead} no_deposco=${noDeposco} orphan=${orphan} unparseable=${unparseable}`);
  if (toShip.length === 0) {
    console.log(`[pull] ${soNumber}: nothing to post`);
    return;
  }

  // Post ship-only (invoiceQuantity=0), mirroring the PO receive-only flow.
  const ref = `SHIP-${soNumber}-${Date.now()}`;
  bcToken = await getBcToken(bcCfg);
  await setExternalDocumentNo(bcOdataBase(bcCfg), bcToken, soNumber, ref);
  console.log(`[pull] ${soNumber}: external doc ref = ${ref}`);
  for (const line of toShip) {
    bcToken = await getBcToken(bcCfg);
    await patchSalesLine(base, bcToken, companyId, line.lineId, { shipQuantity: line.quantity });
    bcToken = await getBcToken(bcCfg);
    const r = await patchSalesLine(base, bcToken, companyId, line.lineId, { invoiceQuantity: 0 });
    console.log(`  PATCHed ${soNumber} ${line.label}: pending shipQty=${r['shipQuantity']} invoiceQty=${r['invoiceQuantity']}`);
  }

  console.log(`[pull] ${soNumber}: POST shipAndInvoice...`);
  bcToken = await getBcToken(bcCfg);
  await postShipAndInvoice(base, bcToken, companyId, so.id);

  // Verify BC advanced; warn loudly if we accidentally invoiced (would be a bug).
  bcToken = await getBcToken(bcCfg);
  const after = await getSalesLines(base, bcToken, companyId, so.id);
  const afterMap = new Map(after.map((l) => [l.id, l]));
  console.log(`[pull] ${soNumber}: BC state after post:`);
  for (const line of toShip) {
    const a = afterMap.get(line.lineId);
    if (!a) { console.log(`  ${line.label}: line not found in post-state`); continue; }
    const inv = a.invoicedQuantity ?? 0;
    console.log(`  ${line.label}: shipped=${a.shippedQuantity} invoiced=${inv}${inv > 0 ? ' ⚠ INVOICED' : ''} (posted +${line.quantity})`);
  }
  console.log(`[pull] ${soNumber}: ✓ shipment posted (ship-only, ref=${ref})`);
}

// ────────────────────────────────────────────────────────────────────────────
// Tick + main loop
// ────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function tick(bcCfg: BcConfig, deposcoCfg: DeposcoConfig): Promise<void> {
  const odata = bcOdataBase(bcCfg);
  const bcToken = await getBcToken(bcCfg);

  for (const prefix of PREFIXES) {
    let sos: BcRow[];
    try {
      sos = await listRecentSos(odata, bcToken, prefix, PER_PREFIX);
    } catch (err) {
      const e = err as AxiosError;
      console.error(`[tick] ${prefix}: list FAILED HTTP ${e.response?.status}: ${(e.message ?? '').slice(0, 200)}`);
      continue;
    }
    console.log(`[tick] ${prefix}: ${sos.length} SO(s): ${sos.map((s) => pick(s, 'No')).join(', ') || '(none)'}`);

    for (const header of sos) {
      const soNumber = pick(header, 'No');
      try {
        await pushSo(bcCfg, deposcoCfg, header);
      } catch (err) {
        const e = err as AxiosError;
        console.error(`[push] ${soNumber} FAILED HTTP ${e.response?.status}: ${JSON.stringify(e.response?.data ?? e.message).slice(0, 500)}`);
      }
      if (PULL_ENABLED) {
        try {
          await pullShipmentsForSo(bcCfg, deposcoCfg, soNumber);
        } catch (err) {
          const e = err as AxiosError;
          console.error(`[pull] ${soNumber} FAILED HTTP ${e.response?.status}: ${(e.message ?? '').slice(0, 200)}`);
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const bcCfg = loadBcConfig();
  const deposcoCfg = loadDeposcoConfig();

  // Single-order mode (web-UI button backend): sync one sales order by number.
  // --push-only = BC→Deposco push (as customerOrder); --post-only = Deposco→BC ship; default = both.
  const orderIdx = process.argv.indexOf('--order');
  const orderArg = orderIdx >= 0 ? process.argv[orderIdx + 1] : null;
  if (orderArg) {
    const pushOnly = process.argv.includes('--push-only');
    const postOnly = process.argv.includes('--post-only');
    const odata = bcOdataBase(bcCfg);
    const token = await getBcToken(bcCfg);
    const header = (await bcGet<{ value: BcRow[] }>(`${odata}/Sales_Order?$filter=${encodeURIComponent(`No eq '${odataStr(orderArg)}'`)}`, token)).value?.[0];
    if (!header) { console.error(`[so-sync] ${orderArg}: not found in BC Sales_Order`); process.exit(1); }
    console.log(`[so] ${orderArg}: ${postOnly ? '' : 'push'}${!pushOnly && !postOnly ? '+' : ''}${pushOnly ? '' : 'ship'}`);
    if (!postOnly) await pushSo(bcCfg, deposcoCfg, header);
    if (!pushOnly) await pullShipmentsForSo(bcCfg, deposcoCfg, orderArg);
    return;
  }

  const once = process.argv.includes('--once');
  console.log(`[so-sync] starting — interval=${INTERVAL_MS}ms prefixes=[${PREFIXES.join(',')}] perPrefix=${PER_PREFIX} pull=${PULL_ENABLED}${once ? ' (single tick)' : ''}`);

  // --once: run a single tick and exit (testing / cron).
  if (once) {
    await tick(bcCfg, deposcoCfg);
    return;
  }

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
