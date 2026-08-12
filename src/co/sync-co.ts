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
 *   SO_TRACKING_ENABLED  (default true)                    — write Deposco tracking onto the posted shipment
 *   BC_*                 BC auth + environment + company
 *   DEPOSCO_*            Deposco auth + env + company
 */
import 'dotenv/config';
import { type AxiosError } from 'axios';
import { getBcToken } from '../auth.js';
import { getDeposcoToken, type DeposcoConfig } from '../deposco.js';
import { loadBcConfig, loadDeposcoConfig, type SyncBcConfig } from '../sync/config.js';
import { bcApiBase, bcOdataBase, bmiApiBase, odataStr, bcGet, pick, numOf, getCompanyId, authReq, type BcRow } from '../sync/bc-client.js';
import { postDeposcoOrder, lookupDeposcoOrderId, fetchShippedFromFulfillment, fetchTrackingForSalesOrder, type DeposcoTracking } from '../sync/orders.js';
import { startRun, finishRun, logEvent, closeDb, dailyDedupe } from '../sync/db-log.js';

// local alias kept so existing signatures below read unchanged
type BcConfig = SyncBcConfig;

const INTERVAL_MS = parseInt(process.env.SO_SYNC_INTERVAL_MS ?? '60000', 10);
const PREFIXES = (process.env.SO_PREFIXES ?? 'PKSO,WSOD,HDSO,DISO').split(',').map((p) => p.trim()).filter(Boolean);
const PER_PREFIX = parseInt(process.env.SO_PER_PREFIX ?? '25', 10);
const PULL_ENABLED = (process.env.SO_PULL_ENABLED ?? 'false').toLowerCase() === 'true';
// Tracking write-back onto the posted sales shipment. Needs the AL extension (>= v2.4.0.0,
// page bmiShipmentTrackings) published to the target BC environment.
const TRACKING_ENABLED = (process.env.SO_TRACKING_ENABLED ?? 'true').toLowerCase() === 'true';
const BU = process.env.DEPOSCO_COMPANY || 'HIVE';
// Deposco orderSource. For customer orders this carries the BC sales order's ProgramID
// (THDMET / DI / WBB / CORP / …) so Deposco can see which programme an order belongs to.
// ORDER_SOURCE is the fallback used when ProgramID is blank, and the known-good value the
// poster retries with if Deposco turns out to validate orderSource against a fixed set.
const ORDER_SOURCE = process.env.DEPOSCO_ORDER_SOURCE ?? 'BusinessCentralOnline';
// Set SO_ORDER_SOURCE_FROM_PROGRAM=false to go back to the flat ORDER_SOURCE for every order.
const ORDER_SOURCE_FROM_PROGRAM = (process.env.SO_ORDER_SOURCE_FROM_PROGRAM ?? 'true').toLowerCase() === 'true';
// Deposco trading partner all COs attach to (hardcoded for now; per-customer mapping later).
const TRADING_PARTNER = process.env.DEPOSCO_TRADING_PARTNER || 'CTPK068417';
// Only push SO lines whose BC Location_Code is a WMS-tracked warehouse (default WMS only).
// Non-WMS lines (PK / DROPSHIP / decoration / on-demand like ODENTIRE, ODTAGSWAG) are
// skipped — Deposco doesn't fulfill them.
const WMS_LOCATIONS = new Set((process.env.SO_WMS_LOCATIONS ?? 'WESTERLY').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));

// ────────────────────────────────────────────────────────────────────────────
// BC fetch (custom OData pages — Sales_Order / Sales_Order_Line)
// Config + bcGet/pick/numOf/odataStr/bcApiBase/bcOdataBase/getCompanyId now live in ../sync/*.
// ────────────────────────────────────────────────────────────────────────────

async function listRecentSos(odata: string, token: string, prefix: string, count: number): Promise<BcRow[]> {
  // Only RELEASED orders sync — an Open order is still being edited; we don't push it to the
  // WMS until it's released. (BC Sales_Order Status is exactly 'Open' | 'Released'.)
  const filter = encodeURIComponent(`startswith(No,'${odataStr(prefix)}') and Status eq 'Released'`);
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

// BC's Sell_to_E_Mail is free text and users stack SEVERAL addresses in it, semicolon-separated.
// Deposco's shipToContact.email is ONE address capped at 50 chars ("size must be between 0 and
// 50") — DISO210942 held 72 chars across two valid addresses and the whole push 400'd.
//
// Always take the part before the first separator, regardless of total length: two short
// addresses would fit under 50 but still aren't a valid single address. If that first one is
// somehow still over the limit, send nothing — 0 is explicitly allowed, and losing a
// notification address beats losing the order.
const DEPOSCO_EMAIL_MAX = 50;
// Deposco caps shipToContact.firstName/lastName at 30 ("size must be between 0 and 30").
// The name split below puts EVERYTHING after the first word into lastName, so any long
// company name overflows — TRFO001656 ("East Providence Decoration (In-House)") produced a
// 32-char lastName and the whole push 400'd.
const DEPOSCO_NAME_MAX = 30;
const capName = (v: string): string => (v.length <= DEPOSCO_NAME_MAX ? v : v.slice(0, DEPOSCO_NAME_MAX).trim());
function firstEmail(raw: string, logKey: string): string {
  const v = raw.trim();
  const parts = v.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  const first = parts[0] ?? '';
  if (parts.length > 1) {
    console.warn(`[push] ${logKey}: Sell_to_E_Mail holds ${parts.length} addresses (${v.length} chars) — sending only the first, '${first}'`);
  }
  if (first.length > DEPOSCO_EMAIL_MAX) {
    console.warn(`[push] ${logKey}: first address is ${first.length} chars, over the ${DEPOSCO_EMAIL_MAX} limit — sending no email`);
    return '';
  }
  return first;
}

// Deposco's Freight Bill To block is a FLAT contact, same shape as shipToContact — its UI shows
// Name / Line1 / City / State Province / Postal Code / Country against these fields.
interface DeposcoFreightBillToContact {
  attention: string; firstName: string; lastName: string;
  line1: string; line2: string; city: string; stateProvince: string; postalCode: string; country: string;
  phone: string;
}

/**
 * Who gets billed for third-party freight. BC's "Third Party Name/Address/City/State/ZIP/Country"
 * block on the sales order IS the Bill-to address — verified on DISO211289, where every value
 * matches (Bill_to_Name "American Diversity Bus Solut", Bill_to_Post_Code "56334", …).
 *
 * This previously sent only { postalCode, country } sourced from SHIP_TO, which put the wrong
 * party's address on the freight bill: DISO211289 showed Freight Bill To Postal Code 17543
 * (Lititz PA, the recipient) instead of 56334 (Glenwood MN, the payer). Name was never sent at all.
 *
 * Phone comes from Sell_to_Phone_No — Bill-to carries no phone, and Bill_to_Contact_No equals
 * Sell_to_Contact_No on these orders, so it is the same party.
 */
function freightBillToContact(h: BcRow): DeposcoFreightBillToContact {
  const name = pick(h, 'Bill_to_Name').trim();
  const parts = name.split(/\s+/);
  return {
    attention: capName(pick(h, 'Bill_to_Contact') || name),
    firstName: capName(parts[0] || name || 'N/A'),
    lastName: capName(parts.slice(1).join(' ') || parts[0] || 'N/A'),
    line1: pick(h, 'Bill_to_Address'),
    line2: pick(h, 'Bill_to_Address_2'),
    city: pick(h, 'Bill_to_City'),
    stateProvince: pick(h, 'Bill_to_County'),
    postalCode: pick(h, 'Bill_to_Post_Code'),
    country: pick(h, 'Bill_to_Country_Region_Code') || 'US',
    phone: pick(h, 'Bill_to_Phone_No', 'Sell_to_Phone_No'),
  };
}

// customerOrder.shipToContact is FLAT — address fields live inside the contact.
interface DeposcoShipToContact {
  attention: string; firstName: string; lastName: string;
  line1: string; line2: string; city: string; stateProvince: string; postalCode: string; country: string;
  phone: string; email: string;
}
function shipToContact(h: BcRow, logKey = ''): DeposcoShipToContact {
  const name = pick(h, 'Ship_to_Name').trim();
  const parts = name.split(/\s+/);
  return {
    attention: pick(h, 'Ship_to_Contact', 'Ship_to_Name'),
    firstName: capName(parts[0] || name || 'N/A'),
    lastName: capName(parts.slice(1).join(' ') || parts[0] || 'N/A'),
    line1: pick(h, 'Ship_to_Address'),
    line2: pick(h, 'Ship_to_Address_2'),
    city: pick(h, 'Ship_to_City'),
    stateProvince: pick(h, 'Ship_to_County', 'Ship_to_State'),
    postalCode: pick(h, 'Ship_to_Post_Code'),
    country: pick(h, 'Ship_to_Country_Region_Code', 'Ship_to_Country_Code') || 'US',
    phone: pick(h, 'Ship_to_Phone_No', 'Sell_to_Phone_No'),
    email: firstEmail(pick(h, 'Sell_to_E_Mail'), logKey),
  };
}

// BC Sales_Order.ProgramID -> Deposco orderSource. 100% populated across the Released orders
// the tick sees, but fall back rather than pushing an empty string if one ever is blank.
function coOrderSource(header: BcRow): string {
  if (!ORDER_SOURCE_FROM_PROGRAM) return ORDER_SOURCE;
  const prog = pick(header, 'ProgramID', 'ProgramId').trim();
  return prog || ORDER_SOURCE;
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
    // Third-party freight billing (only when LAX_Shipping_Payment_Type = 'Third Party').
    freightBillToAccount?: string;
    freightBillToContact?: DeposcoFreightBillToContact;
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

// Third-party freight: Deposco bills the customer's own carrier account through an "eHub" ship-via
// profile, so the BC E-Ship Agent Service code must be translated to Deposco's eHub name (only when
// LAX_Shipping_Payment_Type = 'Third Party'). Keys are normalized (upper, single-spaced) so BC's
// mixed FedEx SNAKE_CASE and UPS spaced codes both match. Values must match Deposco's eHub
// profile names verbatim (case-sensitive), so keep them exactly as in the mapping doc.
const THIRD_PARTY_SHIP_VIA: Record<string, string> = {
  'INTERNATIONAL_ECONOMY': 'eHub Fedex Intl Economy',
  'INTERNATIONAL_PRIORITY': 'eHub Fedex Intl Priority',
  'PRIORITY_OVERNIGHT': 'eHub Fedex Overnight Priority',
  'STANDARD_OVERNIGHT': 'eHub FedEx Standard Overnight',
  'FEDEX_2_DAY_AM': 'eHub Fedex 2day Am',
  'FEDEX_2_DAY': 'eHub Fedex 2day',
  'FEDEX_EXPRESS_SAVER': 'eHub Fedex Express Saver',
  'GROUND_HOME_DELIVERY': 'eHub Fedex Ground Home',
  '3 DAY SELECT': 'eHub Ups 3day Select',
  '2ND DAY AIR': 'eHub Ups 2nd Day',
  '2ND DAY AIR A.M.': 'eHub Ups 2nd Day Am',
  'NEXT DAY AIR SAVER': 'eHub Ups Next Day Saver',
  'NEXT DAY AIR': 'eHub Ups Next Day',
  'EXPEDITED': 'eHub Ups Expedited',
  'EXPRESS': 'eHub Ups Express',
  'EXPRESS PLUS': 'eHub Ups Express Plus',
  'GROUND': 'eHub Ups Ground',
  'FEDEX_GROUND': 'eHub Fedex Ground',
};
const normSvc = (s: string): string => s.trim().toUpperCase().replace(/\s+/g, ' ');
function thirdPartyShipVia(service: string): string | null {
  return service ? (THIRD_PARTY_SHIP_VIA[normSvc(service)] ?? null) : null;
}

function buildCustomerOrder(header: BcRow, rawLines: BcRow[]): DeposcoCustomerOrderPayload {
  const soNumber = pick(header, 'No');
  const ship = headerShipping(header);
  // Third-party freight billing: when the SO bills freight to a third party, add the account #
  // + a freight bill-to with the ship-to zip/country (freightTermsType is already passed through
  // from LAX_Shipping_Payment_Type by headerShipping). ALSO translate the E-Ship Agent Service
  // code into Deposco's eHub ship-via profile — an unmapped code falls back to the raw code + warns.
  const thirdParty = /third\s*party/i.test(pick(header, 'LAX_Shipping_Payment_Type'));
  const freight = thirdParty
    ? {
        freightBillToAccount: pick(header, 'LAX_Third_Party_Ship_Acct_No'),
        freightBillToContact: freightBillToContact(header),
      }
    : {};
  if (ship && thirdParty) {
    const svc = pick(header, 'LAX_E_Ship_Agent_Service');
    const mapped = thirdPartyShipVia(svc);
    if (mapped) ship.shipVia = mapped;
    else console.warn(`[co] ${soNumber}: third-party freight but E-Ship service '${svc}' has no eHub mapping — using raw ship-via '${ship.shipVia}'`);
  }
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
      orderSource: coOrderSource(header),
      placedDate: toDateTime(pick(header, 'Order_Date', 'Document_Date')),
      ...(ship ? { shipVia: ship.shipVia, shipVendor: ship.shipVendor, freightTermsType: ship.freightTermsType } : {}),
      ...freight,
      shipToContact: shipToContact(header, soNumber),
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
// This used to hit the `beta` API version instead of `latest` (per an old ops request). That
// broke BADLY: /beta is stale — it returned 50 orders whose newest was 2024-05-20 and ZERO of
// today's, so this lookup answered "not found" for every current order. Consequences seen live
// on 2026-08-11:
//   1. pushSo's existence check never matched, so the tick CREATED a duplicate customerOrder
//      every 5 minutes — 25 of 49 order numbers were duplicated in Deposco production, many ×11.
//   2. pullShipmentsForSo also uses this, so every shipment pull short-circuited on
//      "not in Deposco yet" — no shipment ever came back, and therefore no tracking either.
// /latest resolves the same filter correctly (verified: TRFO001660 -> 1 row on latest, 0 on beta).
// DEPOSCO_CO_LOOKUP_BASE can force a different base if ops ever needs it again, but the default
// must stay on the environment we actually write to.
const lookupCustomerOrderId = (deposcoCfg: DeposcoConfig, token: string, externalOrderNumber: string) => {
  const override = process.env.DEPOSCO_CO_LOOKUP_BASE;
  const apiBase = override ? deposcoCfg.apiBase.replace('/latest', `/${override.replace(/^\//, '')}`) : deposcoCfg.apiBase;
  return lookupDeposcoOrderId({ ...deposcoCfg, apiBase }, token, '/orders/customerOrders', { externalOrderNumber });
};

async function postSo(bcCfg: BcConfig, deposcoCfg: DeposcoConfig, soNumber: string, payload: DeposcoCustomerOrderPayload, label: string): Promise<PostResult> {
  return postDeposcoOrder(bcCfg, deposcoCfg, '/orders/customerOrders', payload, soNumber, label, { worker: 'co' });
}

async function pushSo(bcCfg: BcConfig, deposcoCfg: DeposcoConfig, header: BcRow): Promise<PostResult> {
  const odata = bcOdataBase(bcCfg);
  const soNumber = pick(header, 'No');
  // Only RELEASED orders push to the WMS — Open = still being edited. The scheduled tick already
  // pre-filters Released, but the manual --order button (web UI) fetches any order by number, so
  // guard here too — this is the single choke point both paths flow through.
  const status = pick(header, 'Status');
  if (status !== 'Released') {
    console.log(`[push] ${soNumber}: status '${status || '(unknown)'}' — not Released, skipping (only Released orders push)`);
    return 'skip';
  }
  const bcToken = await getBcToken(bcCfg);
  const lines = await getSoLines(odata, bcToken, soNumber);
  if (lines.length === 0) {
    console.log(`[push] ${soNumber}: 0 item lines — skipping`);
    return 'skip';
  }
  // customerOrders POST does NOT upsert — it creates a brand-new CO every time, so the
  // per-tick re-push was minting duplicate Deposco orders. Skip if one already exists.
  // (Updating an existing CO on SO edits is a follow-up — needs Deposco update-by-id.)
  const dToken = await getDeposcoToken(deposcoCfg);
  const existing = await lookupCustomerOrderId(deposcoCfg, dToken, soNumber);
  if (existing !== null) {
    console.log(`[push] ${soNumber}: already in Deposco (CO id ${existing}) — skipping create (no upsert yet)`);
    return 'skip';
  }
  const payload = buildCustomerOrder(header, lines);
  const via = payload.customerOrder.shipVia;
  if (!via) console.warn(`[push] ${soNumber}: ⚠ no ship-via on SO header — CO may land in review`);
  return postSo(bcCfg, deposcoCfg, soNumber, payload, `${lines.length} WMS line(s)${via ? `, via ${via}` : ''}`);
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

async function pullShipmentsForSo(bcCfg: BcConfig, deposcoCfg: DeposcoConfig, soNumber: string, runId: number | null = null): Promise<void> {
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
    // Still try tracking: a shipment may have posted on an earlier tick with the tracking
    // write failing (or Deposco may have labelled it only afterwards). Without this, any
    // transient tracking failure would be permanent — the next tick sees delta=0 and stops.
    await writeTrackingBack(bcCfg, deposcoCfg, soNumber, null, orderId, runId);
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

  // Stamp Deposco tracking onto the shipment we just posted. Keyed on `ref`, which BC carried
  // onto the posted shipment's External Document No. — exact even when one SO has several.
  await writeTrackingBack(bcCfg, deposcoCfg, soNumber, ref, orderId, runId);
}

// ────────────────────────────────────────────────────────────────────────────
// Tracking write-back: Deposco outbound shipment → BC posted sales shipment (SLSS…)
// ────────────────────────────────────────────────────────────────────────────
//
// Posted sales shipments are NOT writable over OData ("Control 'Package Tracking No.' is
// read-only"), and a page over the table modifies under the caller's rights, which the S2S
// license forbids. So this POSTs to our AL extension's bmiShipmentTrackings, whose codeunit
// holds the elevated permission. See al/src/PKShipTrackingMgt.Codeunit.al.
//
// Never fatal: tracking is an annotation. A failure here must not make the caller think the
// shipment post failed — it already succeeded.
async function writeTrackingBack(
  bcCfg: BcConfig,
  deposcoCfg: DeposcoConfig,
  soNumber: string,
  externalDocumentNo: string | null,
  customerOrderId: number,
  runId: number | null = null,
): Promise<void> {
  const logTrack = (status: 'ok' | 'skip' | 'fail', message: string, detail?: unknown, side: 'bc' | 'deposco' = 'bc') =>
    logEvent({ runId, worker: 'co', direction: 'deposco->bc', entityType: 'shipment',
               entityId: soNumber, action: 'tracking', status, side, message, detail,
               dedupeKey: dailyDedupe('co-track', `${soNumber}:${externalDocumentNo ?? 'backfill'}`, message) });

  if (!TRACKING_ENABLED) {
    console.log(`[track] ${soNumber}: disabled (SO_TRACKING_ENABLED=false)`);
    await logTrack('skip', 'tracking write-back disabled (SO_TRACKING_ENABLED=false)');
    return;
  }
  try {
    const dToken = await getDeposcoToken(deposcoCfg);
    const co = await authReq<{ customerOrder?: { fulfillmentOrders?: Array<{ id: number }> } }>(
      'get', `${deposcoCfg.apiBase}/orders/customerOrders/${customerOrderId}`, dToken);

    const all: DeposcoTracking[] = [];
    for (const fo of co.customerOrder?.fulfillmentOrders ?? []) {
      all.push(...await fetchTrackingForSalesOrder(deposcoCfg, dToken, fo.id));
    }
    if (all.length === 0) {
      console.log(`[track] ${soNumber}: no tracking numbers in Deposco yet`);
      await logTrack('skip', 'no tracking number on any Deposco outbound shipment yet', undefined, 'deposco');
      return;
    }

    // Deposco emits shipments that have a tracking number but shipped ZERO units — a label
    // created and then not used. Those must never become the primary tracking number (BC's
    // Track Package would point at an empty label), so drop them when any real one exists.
    const real = all.filter((t) => t.shippedUnits > 0);
    const empty = all.length - real.length;
    if (empty > 0) console.log(`[track] ${soNumber}: ignoring ${empty} zero-quantity label(s): ${all.filter((t) => t.shippedUnits === 0).map((t) => t.trackingNumber).join(', ')}`);
    const used = real.length > 0 ? real : all;   // all-empty => keep them rather than lose the info

    const bcToken = await getBcToken(bcCfg);
    const companyId = await getCompanyId(bcCfg, bcToken);

    // Backfill mode (no fresh ref): target posted shipments of this SO that still have no
    // tracking. Ambiguous when several qualify — bail rather than guess, since the wrong
    // tracking number on a real shipment is worse than none.
    let targetShipmentNo: string | null = null;
    if (!externalDocumentNo) {
      const untracked = await bcGet<{ value: Array<{ No: string }> }>(
        `${bcOdataBase(bcCfg)}/Posted_Sales_Shipment_Excel?$filter=${encodeURIComponent(
          `Order_No eq '${odataStr(soNumber)}' and Package_Tracking_No eq ''`)}&$select=No`, bcToken);
      const rows = untracked.value ?? [];
      if (rows.length === 0) { console.log(`[track] ${soNumber}: nothing to backfill`); return; }
      if (rows.length > 1) {
        const m = `${rows.length} posted shipments lack tracking — ambiguous, skipping backfill`;
        console.warn(`[track] ${soNumber}: ⚠ ${m}`);
        await logTrack('skip', m, { candidates: rows.map((r) => r.No) });
        return;
      }
      targetShipmentNo = rows[0].No;
      console.log(`[track] ${soNumber}: backfilling ${targetShipmentNo}`);
    }

    // One BC posted shipment can cover several Deposco parcels (SO12404 ships one line on 5
    // labels). Full list goes to our Text[250] field; the AL puts the FIRST number in BC's
    // standard field. Cap the join at whole tracking numbers — the buffer field is Text[250]
    // and an overflow would make BC reject the POST, losing the tracking entirely rather than
    // just the tail of a long list.
    const joinCapped = (vals: string[], max = 250): { text: string; dropped: number } => {
      const kept: string[] = [];
      for (const v of vals) {
        if ([...kept, v].join(',').length > max) break;
        kept.push(v);
      }
      return { text: kept.join(','), dropped: vals.length - kept.length };
    };
    const tn = joinCapped(used.map((t) => t.trackingNumber));
    const dsn = joinCapped(used.map((t) => t.shipmentNo), 20);   // Code[20] on the buffer
    if (tn.dropped > 0) console.warn(`[track] ${soNumber}: ⚠ ${tn.dropped} tracking number(s) dropped — list exceeds 250 chars`);
    const primary = used[0];
    const payload = {
      ...(targetShipmentNo ? { shipmentNo: targetShipmentNo } : { externalDocumentNo }),
      deposcoShipmentNo: dsn.text,
      deposcoSalesOrderNo: primary.salesOrderNo,
      trackingNo: tn.text,
      trackingUrl: primary.trackingUrl,
      carrier: primary.carrier,
      shipVia: primary.shipVia,
      shipMethod: primary.shipMethod,
      containerLpn: primary.containerLpn,
      totalPackages: used.reduce((s, t) => s + t.totalPackages, 0),
      totalWeight: used.reduce((s, t) => s + t.totalWeight, 0),
      ...(primary.actualShipDate ? { actualShipDate: primary.actualShipDate } : {}),
    };
    const res = await authReq<{ applied?: boolean; appliedTo?: string; errorMessage?: string }>(
      'post', `${bmiApiBase(bcCfg)}/companies(${companyId})/bmiShipmentTrackings`, bcToken,
      { data: payload, headers: { 'Content-Type': 'application/json' } });

    if (res.applied) {
      console.log(`[track] ${soNumber}: ✓ ${res.appliedTo} ← ${payload.carrier} ${payload.trackingNo}`);
      await logTrack('ok', `${res.appliedTo}: ${payload.carrier} ${payload.trackingNo}`,
                     { shipment: res.appliedTo, carrier: payload.carrier, trackingNo: payload.trackingNo,
                       trackingUrl: payload.trackingUrl, deposcoShipmentNo: payload.deposcoShipmentNo,
                       parcels: used.length, emptyLabels: empty, droppedTracking: tn.dropped });
    } else {
      const m = `not applied: ${res.errorMessage ?? 'unknown'}`;
      console.warn(`[track] ${soNumber}: ⚠ ${m}`);
      await logTrack('fail', m, { payload });
    }
  } catch (err) {
    const e = err as AxiosError;
    const body = JSON.stringify(e.response?.data ?? (err as Error).message).slice(0, 300);
    console.error(`[track] ${soNumber}: FAILED (shipment itself DID post) HTTP ${e.response?.status}: ${body}`);
    // Which side failed: reading Deposco, or writing BC's bmiShipmentTrackings.
    const side = /deposco\.com/i.test(String(e.config?.url ?? '')) ? 'deposco' : 'bc';
    await logTrack('fail', `HTTP ${e.response?.status ?? e.code ?? '?'}: ${body.slice(0, 180)}`,
                   { url: e.config?.url, externalDocumentNo }, side);
  }
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

  // One run per tick. Log only NEW pushes (ok) and failures — not the every-tick skips of
  // already-synced orders (that would flood sync_events since most Released orders already exist).
  const runId = await startRun('co', process.env.SYNC_TRIGGER || 'manual');
  // pullFail is counted separately from `fail` (pushes) so a run row shows which half broke.
  let ok = 0, skip = 0, fail = 0, pullFail = 0;

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
        const r = await pushSo(bcCfg, deposcoCfg, header);
        if (r === 'ok') { ok++; await logEvent({ runId, worker: 'co', direction: 'bc->deposco', entityType: 'order', entityId: soNumber, action: 'push', status: 'ok', message: 'pushed to Deposco' }); }
        else { skip++; await logEvent({ runId, worker: 'co', direction: 'bc->deposco', entityType: 'order', entityId: soNumber, action: 'push', status: 'skip', message: 'already in Deposco / no WMS lines', dedupeKey: dailyDedupe('co-skip', soNumber, 'skip') }); }
      } catch (err) {
        const e = err as AxiosError;
        const body = JSON.stringify(e.response?.data ?? e.message).slice(0, 300);
        // 429 bodies are empty, so the text match alone mislabelled rate limits as a BC fault.
      const side = e.response?.status === 429 || /EOM|not subscribed|deposco/i.test(body) ? 'deposco' : 'bc';
        console.error(`[push] ${soNumber} FAILED HTTP ${e.response?.status}: ${body.slice(0, 500)}`);
        fail++;
        const msg = `HTTP ${e.response?.status}: ${body.slice(0, 180)}`;
        await logEvent({ runId, worker: 'co', direction: 'bc->deposco', entityType: 'order', entityId: soNumber, action: 'push', status: 'fail', side, message: msg, dedupeKey: dailyDedupe('co', soNumber, msg) });
      }
      if (PULL_ENABLED) {
        try {
          await pullShipmentsForSo(bcCfg, deposcoCfg, soNumber, runId);
        } catch (err) {
          // This used to console.error only, which made shipment-pull failures invisible in
          // /logs — DISO211236 re-staged and re-failed every tick for a day with nothing to see
          // but a churning External Document No. BC's real complaint (e.g. insufficient
          // inventory at the ship-from location) is in the response body, so keep the whole
          // body in `detail` and only truncate the summary line.
          const e = err as AxiosError;
          const body = JSON.stringify(e.response?.data ?? e.message);
          const side = e.response?.status === 429 || /EOM|not subscribed|deposco/i.test(body) ? 'deposco' : 'bc';
          console.error(`[pull] ${soNumber} FAILED HTTP ${e.response?.status}: ${body.slice(0, 500)}`);
          pullFail++;
          const msg = `shipment pull: HTTP ${e.response?.status ?? '?'}: ${body.slice(0, 300)}`;
          await logEvent({ runId, worker: 'co', direction: 'deposco->bc', entityType: 'order', entityId: soNumber, action: 'pull', status: 'fail', side, message: msg, detail: body.slice(0, 4000), dedupeKey: dailyDedupe('co-pull', soNumber, msg) });
        }
      }
    }
  }

  await finishRun(runId, fail > 0 || pullFail > 0 ? 'partial' : 'ok', { posted: ok, skipped: skip, failed: fail, pullFailed: pullFail });
  console.log(`[tick] done — ${ok} pushed, ${skip} skipped, ${fail} push-failed, ${pullFail} pull-failed`);
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
    await closeDb();
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
