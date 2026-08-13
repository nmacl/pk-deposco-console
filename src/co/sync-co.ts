/**
 * Long-running CUSTOMER-ORDER sync worker — sibling of po/sync.ts (the PO monolith).
 * Deploy as its own worker process. (Sourced from BC sales orders; pushed to Deposco
 * as customerOrders — the Deposco entity is a customerOrder, not a salesOrder.)
 *
 * Every SO_SYNC_INTERVAL_MS:
 *   1. For each SO prefix (PKSO/WSOD/HDSO/DISO), list the orders CHANGED since that prefix's
 *      cursor (SystemModifiedAt high-water mark in sync_cursors), oldest first.
 *   2. For each SO:
 *      - Push BC → Deposco: POST /orders/customerOrders (wrapped { customerOrder: {...} }
 *        payload — unlike salesOrders/purchaseOrders). On a 404 missing-item, lazy-create
 *        from BC and retry. On a 400 "in progress", skip (warehouse already working it).
 *      - Pull Deposco → BC (shipment confirmation): IMPLEMENTED, gated behind
 *        SO_PULL_ENABLED (default false). Reads coLines[].shippedQuantity off the CO
 *        detail (no /shipments endpoint exists), deltas vs BC cumulative shippedQuantity
 *        per line, and posts SHIP-ONLY via our own bmiSalesOrders/postShipment action
 *        (AL page 60209 → codeunit 60223, extension >= 2.8.0.0). Qty. to Invoice is left
 *        untouched, and the customer's External Document No. is never written at all — the
 *        posted shipment is identified by diffing the order's shipments around the post.
 *
 * Modeled on the proven build-co.mjs (push) + po/sync.ts (worker loop + lazy item create).
 * Item-create machinery is duplicated from po/sync.ts on purpose: two standalone monoliths
 * now, factor into shared modules later.
 *
 * Env:
 *   SO_SYNC_INTERVAL_MS  (default 60000)                   — sleep between ticks
 *   SO_PREFIXES          (default "PKSO,WSOD,HDSO,DISO")   — BC SO number prefixes to sync
 *   SO_PER_PREFIX        (default 25)                      — max orders per prefix per tick
 *   SO_CURSOR_ENABLED    (default true)                    — use the SystemModifiedAt cursor;
 *                                                            false = old newest-N window
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
import { postDeposcoOrder, lookupDeposcoOrderId, fetchShippedFromFulfillment, fetchTrackingForSalesOrder, auditPushedCustomerOrder, fetchOutboundShipments, resolveCustomerOrderNumbers, type DeposcoTracking } from '../sync/orders.js';
import { startRun, finishRun, logEvent, closeDb, dailyDedupe, readCursor, writeCursor } from '../sync/db-log.js';

// local alias kept so existing signatures below read unchanged
type BcConfig = SyncBcConfig;

const INTERVAL_MS = parseInt(process.env.SO_SYNC_INTERVAL_MS ?? '60000', 10);
const PREFIXES = (process.env.SO_PREFIXES ?? 'PKSO,WSOD,HDSO,DISO').split(',').map((p) => p.trim()).filter(Boolean);
const PER_PREFIX = parseInt(process.env.SO_PER_PREFIX ?? '25', 10);
const PULL_ENABLED = (process.env.SO_PULL_ENABLED ?? 'false').toLowerCase() === 'true';
// Numeric rotating scan (see listOrdersToSync), replacing the newest-25-by-Order_Date window that
// left 1,278 of 1,408 open orders permanently unreachable. The rotation position per prefix is a
// document NUMBER held in sync_cursors. SO_CURSOR_ENABLED=false pins it to the HEAD pass only
// (newest by number), which is still numeric — there is no date-ordered path left to fall back to.
const CURSOR_ENABLED = (process.env.SO_CURSOR_ENABLED ?? 'true').toLowerCase() === 'true';
// Newest-by-number orders re-read every tick so a brand-new order doesn't wait for the rotation.
const SCAN_HEAD = parseInt(process.env.SO_SCAN_HEAD ?? '25', 10);
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

/**
 * Candidate selection is NUMERIC — never by date. NOTHING that picks work out of BC may sort or
 * filter on a date field.
 *
 * Dates on a BC document are business values: a user can set Order_Date/Posting_Date to whatever
 * the paperwork says, and the integrations backdate them routinely. So an order can be CREATED
 * already sorted into the middle of a date-ordered list, and a newest-N window will never contain
 * it — not late, never. That is not hypothetical: on 2026-08-12, 17 DISO orders that Deposco had
 * shipped Complete sat at BC shipped=0 because they ranked 57th-240th of 399 by Order_Date while
 * the tick read the newest 25. ~273 units left the warehouse with BC still showing them on hand,
 * and NOT ONE error was logged, because the code never looked at those orders.
 * Document numbers are issued sequentially and cannot be edited, so they are the only safe key.
 * (The inventory worker already does this with `entryNo gt N`, and the PO worker with
 * `number gt 'WSP…'`; this brings the sales-order worker in line.)
 *
 * A plain high-water mark is NOT enough either. An old order can need work again long after
 * newer ones — DISO210925 was modified today — and `No gt cursor` would skip it forever, which is
 * the same starvation on a different axis. So this is a ROTATING scan over the open set:
 *
 *   HEAD    the newest SCAN_HEAD orders by number, every tick, so a brand-new order pushes
 *           immediately instead of waiting for the rotation to come round to it.
 *   ROTATE  the next `count` orders above the cursor, ascending. On reaching the end the cursor
 *           resets and the next lap starts from the bottom, so EVERY open order is visited on a
 *           fixed cycle regardless of its number or age.
 *
 * `Completely_Shipped eq false` keeps the working set bounded (finished orders drop out of the
 * rotation on their own), so a lap stays short and the cost per tick stays flat.
 */
interface ScanBatch { rows: BcRow[]; nextCursor: string; wrapped: boolean }

async function listOrdersToSync(odata: string, token: string, prefix: string, count: number, cursor: string | null): Promise<ScanBatch> {
  // Only RELEASED orders sync — an Open order is still being edited; we don't push it to the WMS
  // until it's released. (BC Sales_Order Status is exactly 'Open' | 'Released'.)
  const open = `startswith(No,'${odataStr(prefix)}') and Status eq 'Released' and Completely_Shipped eq false`;
  const q = (filter: string, order: string, top: number): string =>
    `${odata}/Sales_Order?$filter=${encodeURIComponent(filter)}&$orderby=${order}&$top=${top}`;

  const head = (await bcGet<{ value: BcRow[] }>(q(open, 'No desc', SCAN_HEAD), token)).value ?? [];

  // The cursor MUST look like a document number. It used to hold a SystemModifiedAt timestamp,
  // and those values survived the switch to numeric rotation: `No gt '2026-08-12T17:13:54.753Z'`
  // is a 24-char value against a Code[20] field, so BC rejected the whole query with
  // Application_FilterErrorException. listOrdersToSync threw, the tick caught it and `continue`d,
  // and every prefix was skipped on every tick — the sales-order push stopped entirely and 199
  // Released orders (4,666 units) sat unimported with nothing in the logs but a silent skip.
  // Anything that isn't a plausible number for this prefix is discarded and the lap restarts.
  const valid = cursor !== null && cursor.length > 0 && cursor.length <= 20 && cursor.startsWith(prefix);
  if (cursor && !valid) console.warn(`[tick] ${prefix}: ignoring unusable cursor ${JSON.stringify(cursor)} — restarting the rotation from the beginning`);
  const from = valid ? cursor : '';
  const rotFilter = from ? `${open} and No gt '${odataStr(from)}'` : open;
  const rot = (await bcGet<{ value: BcRow[] }>(q(rotFilter, 'No asc', count), token)).value ?? [];

  // A short batch means the end of the set — wrap so the next tick starts a fresh lap.
  const wrapped = rot.length < count;
  const nextCursor = wrapped ? '' : pick(rot[rot.length - 1], 'No');

  // HEAD and ROTATE overlap once the rotation reaches the top of the range.
  const seen = new Set<string>();
  const rows: BcRow[] = [];
  for (const r of [...head, ...rot]) {
    const no = pick(r, 'No');
    if (no && !seen.has(no)) { seen.add(no); rows.push(r); }
  }
  return { rows, nextCursor, wrapped };
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
  /** Deposco's "Bill To Name". It is NOT derived from firstName/lastName — Deposco confirmed
   *  (test order UA SO12562) that the bill-to name has to arrive in this field or their Bill To
   *  Name shows empty, which is what we were doing: splitting Bill_to_Name into first/last and
   *  never sending contactName. Carries the full unsplit name. */
  contactName: string;
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
    // Full name, deliberately NOT put through capName: the 30-char cap exists because Deposco
    // limits firstName/lastName, and truncating a payer's legal name on a freight bill would be
    // worse than a retry. postDeposcoOrder trims any single oversize field and re-posts if
    // Deposco objects, so the whole name goes out and only gets shortened if it actually has to.
    contactName: name || pick(h, 'Bill_to_Contact') || 'N/A',
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
const lookupCustomerOrderId = (deposcoCfg: DeposcoConfig, token: string, externalOrderNumber: string, opts: { liveOnly?: boolean } = {}) => {
  const override = process.env.DEPOSCO_CO_LOOKUP_BASE;
  const apiBase = override ? deposcoCfg.apiBase.replace('/latest', `/${override.replace(/^\//, '')}`) : deposcoCfg.apiBase;
  return lookupDeposcoOrderId({ ...deposcoCfg, apiBase }, token, '/orders/customerOrders', { externalOrderNumber }, opts);
};

async function postSo(bcCfg: BcConfig, deposcoCfg: DeposcoConfig, soNumber: string, payload: DeposcoCustomerOrderPayload, label: string): Promise<PostResult> {
  return postDeposcoOrder(bcCfg, deposcoCfg, '/orders/customerOrders', payload, soNumber, label, { worker: 'co' });
}

async function pushSo(bcCfg: BcConfig, deposcoCfg: DeposcoConfig, header: BcRow, runId: number | null = null): Promise<PostResult> {
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
  // liveOnly: an order whose copies are ALL cancelled must count as absent, otherwise cancelling
  // a bad CO in Deposco (the only way to fix one — there's no PATCH) would permanently block the
  // clean re-push.
  const dToken = await getDeposcoToken(deposcoCfg);
  const existing = await lookupCustomerOrderId(deposcoCfg, dToken, soNumber, { liveOnly: true });
  if (existing !== null) {
    console.log(`[push] ${soNumber}: already in Deposco (CO id ${existing}) — skipping create (no upsert yet)`);
    return 'skip';
  }
  const payload = buildCustomerOrder(header, lines);
  const via = payload.customerOrder.shipVia;
  if (!via) console.warn(`[push] ${soNumber}: ⚠ no ship-via on SO header — CO may land in review`);
  const result = await postSo(bcCfg, deposcoCfg, soNumber, payload, `${lines.length} WMS line(s)${via ? `, via ${via}` : ''}`);
  if (result === 'ok') await auditPush(bcCfg, deposcoCfg, soNumber, payload, runId);
  return result;
}

/**
 * A 2xx from customerOrders does NOT mean every line landed usable. The endpoint returns 202
 * Accepted and materializes the order asynchronously, and it silently writes a line with a null
 * item when the item doesn't exist (see auditPushedCustomerOrder). Read the
 * order back, lazy-create whatever was missing, and record a desync so the broken order is
 * visible in /logs instead of sitting in Review behind a green "pushed to Deposco".
 * Never fatal: the push itself already succeeded.
 */
async function auditPush(bcCfg: BcConfig, deposcoCfg: DeposcoConfig, soNumber: string, payload: DeposcoCustomerOrderPayload, runId: number | null): Promise<void> {
  try {
    const intended = new Map(payload.customerOrder.coLines.data.map((l) => [l.externalLineNumber, l.itemNumber]));
    const dToken = await getDeposcoToken(deposcoCfg);
    const audit = await auditPushedCustomerOrder(bcCfg, deposcoCfg, dToken, soNumber, intended);
    if (!audit) return;
    if (audit.truncated) {
      const m = `Deposco returned only ${audit.checked} of ${payload.customerOrder.coLines.data.length} line(s) on read-back — lines beyond the first page cannot be audited`;
      console.warn(`[audit] ${soNumber}: ⚠ ${m}`);
      await logEvent({ runId, worker: 'co', direction: 'bc->deposco', entityType: 'order', entityId: soNumber, action: 'audit', status: 'desync', side: 'deposco', message: m, dedupeKey: dailyDedupe('co-audit-trunc', soNumber, 'truncated') });
    }
    if (audit.unlinked.length === 0) {
      // Say so explicitly: silence would be indistinguishable from the audit never running.
      console.log(`[audit] ${soNumber}: ✓ CO ${audit.orderId} — all ${audit.checked} readable line(s) have a linked item`);
      return;
    }
    const detail = audit.unlinked.map((u) => `L${u.externalLineNumber}=${u.itemNumber}(${u.quantity})`).join(' ');
    const m = `${audit.unlinked.length} line(s) landed in Deposco with NO item linked: ${detail}. ${audit.created.length ? `Created ${audit.created.join(', ')} — ` : 'Item create failed — '}CO ${audit.orderId} cannot be repaired via API; cancel it in Deposco and re-push.`;
    console.error(`[audit] ${soNumber}: ❌ ${m}`);
    await logEvent({ runId, worker: 'co', direction: 'bc->deposco', entityType: 'order', entityId: soNumber, action: 'audit', status: 'desync', side: 'deposco', message: m,
      detail: { customerOrderId: audit.orderId, unlinked: audit.unlinked, itemsCreated: audit.created },
      dedupeKey: dailyDedupe('co-audit', soNumber, detail) });
  } catch (err) {
    console.warn(`[audit] ${soNumber}: read-back audit failed (push itself succeeded): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pull: Deposco shipment confirmation → BC  (gated behind SO_PULL_ENABLED)
// ────────────────────────────────────────────────────────────────────────────
//
// Deposco has NO /shipments endpoint — shipment state is inline on the CO detail:
// GET /orders/customerOrders/{id} → coLines[].shippedQuantity (cumulative), keyed by
// externalLineNumber (== BC Sales_Order_Line.Line_No, which the push now stamps). We
// delta that against BC's cumulative shippedQuantity per line and post a ship-only through our
// own AL action (bmiSalesOrders/postShipment) — the direct mirror of the PO receive-only pull.
// It used to go through Microsoft.NAV.shipAndInvoice with Qty. to Invoice zeroed per line; see
// postShipmentOnly for why that failed on any order carrying a line we don't ship.

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

// SHIP-ONLY post, via our own AL action (page 60209 "PK Sales Order API" → codeunit 60223,
// extension v2.8.0.0+). BC's api/v2.0 salesOrders exposes only Microsoft.NAV.shipAndInvoice —
// there is no ship-only counterpart (confirmed against this environment's $metadata) — so this
// used to call shipAndInvoice and suppress the invoice half by zeroing Qty. to Invoice on every
// line it shipped. That silently broke on any order carrying a line we did NOT ship: BC stages
// EVERY line at full Quantity on release, so an untouched charge line stayed queued to invoice,
// posting it hit the general ledger, and PK_BC_customization's Gen. Jnl.-Post Line subscriber
// tried to INSERT a "SalesPerson Commission" row that the S2S identity may not write:
//   HTTP 400 "(TableData 50026 SalesPerson Commission Insert: PK_BC_customization)"
// Posting is one transaction, so the shipment rolled back with it — DISO211236 re-failed every
// tick for a day. Ship-only cannot reach that path: a G/L Account line only touches the ledger
// when INVOICED. Qty. to Invoice is now left alone entirely; BC re-derives it after posting.
async function postShipmentOnly(cfg: BcConfig, token: string, companyId: string, soNumber: string): Promise<void> {
  const bmi = `${bmiApiBase(cfg)}/companies(${companyId})`;
  // Resolve the SystemId off our own page rather than assuming salesOrders.id is the same GUID.
  const row = (await authReq<{ value: Array<{ systemId: string }> }>('get',
    `${bmi}/bmiSalesOrders?$filter=${encodeURIComponent(`no eq '${odataStr(soNumber)}'`)}`, token)).value?.[0];
  if (!row) throw new Error(`SO ${soNumber} not found on bmiSalesOrders — is extension >= 2.8.0.0 installed?`);
  await authReq('post', `${bmi}/bmiSalesOrders(${row.systemId})/Microsoft.NAV.postShipment`, token, { data: {} });
}

// The posted shipment this run created, identified by diffing the order's shipments around the
// post rather than by pre-stamping a synthetic ref (see the External Document No. note below).
// Returns the
// numbers of every posted shipment currently on the order.
async function shipmentNosForOrder(cfg: BcConfig, token: string, companyId: string, soNumber: string): Promise<Set<string>> {
  const bmi = `${bmiApiBase(cfg)}/companies(${companyId})`;
  const rows = (await authReq<{ value: Array<{ no: string }> }>('get',
    `${bmi}/bmiSalesShipments?$filter=${encodeURIComponent(`orderNo eq '${odataStr(soNumber)}'`)}&$select=no`, token)).value ?? [];
  return new Set(rows.map((r) => r.no));
}

// NOTE — External Document No. is DELIBERATELY not written by this worker any more.
//
// On this instance that field is captioned CUSTOMER PURCHASE ORDER NO. and the business uses it:
// it holds the customer's own PO, prints on their documents, and is what they reconcile against.
// This worker used to overwrite it with `SHIP-{soNo}-{epoch}` before every post, for two reasons:
//   1. "Ext. Doc. No. Mandatory" in Sales & Receivables Setup can reject a blank one, and
//   2. the tracking write-back needed something to match the posted shipment on.
// The stamp destroyed the customer's value on EVERY tick, and worst on orders whose post then
// failed — DISO211236 was re-stamped every 5 minutes for a day, DISO211300 still carries one.
//
// Reason 2 is gone: the posted shipment is now identified by diffing shipmentNosForOrder around
// the post, which is exact even when one order ships several times. Reason 1 has not bitten in
// testing (WSOD304108 posted SLSS846339 fine), but if a "must have a value" error ever appears,
// the ref belongs in a field of OUR OWN — a tableextension on Sales Header, the way the tracking
// fields live on our Sales Shipment Header extension — never in the customer's PO field.

interface ShipLine { lineId: string; label: string; quantity: number }

async function pullShipmentsForSo(bcCfg: BcConfig, deposcoCfg: DeposcoConfig, soNumber: string, runId: number | null = null): Promise<void> {
  const dToken = await getDeposcoToken(deposcoCfg);
  const orderId = await lookupCustomerOrderId(deposcoCfg, dToken, soNumber);
  if (orderId === null) {
    console.log(`[pull] ${soNumber}: not in Deposco yet, skipping shipment pull`);
    return;
  }

  // Aggregate Deposco shipped qty by BC Line_No (externalLineNumber == Line_No).
  const { lines: coLines, truncatedOrders } = await fetchShippedFromFulfillment(deposcoCfg, dToken, orderId);
  // Deposco caps a nested line collection at 10 rows with no reachable page 2, so on a big order
  // some shipped lines are simply invisible to us and will NEVER post. Post what we can see, but
  // say so — otherwise BC is quietly left short and the next tick sees delta=0 and agrees.
  if (truncatedOrders.length > 0) {
    const m = `Deposco truncated the line list on fulfillment order(s) ${truncatedOrders.join(', ')} — shipped lines beyond the first page are unreadable and will NOT post to BC. Post the remainder manually.`;
    console.error(`[pull] ${soNumber}: ❌ ${m}`);
    await logEvent({ runId, worker: 'co', direction: 'deposco->bc', entityType: 'order', entityId: soNumber, action: 'pull', status: 'desync', side: 'deposco', message: m, dedupeKey: dailyDedupe('co-pull-trunc', soNumber, truncatedOrders.join(',')) });
  }
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

  // NOTHING is written to the sales order header here. External Document No. is captioned
  // CUSTOMER PURCHASE ORDER NO. on this instance and is in active use by the business — see
  // the note above pullShipmentsForSo. We no longer need a ref there at all: the posted shipment
  // is identified by diffing shipmentNosForOrder around the post.
  //
  // Stage what ships, and only that. Qty. to Invoice is deliberately NOT touched: the post below
  // is ship-only at the BC end, so there is no invoice half left to suppress. (BC derives
  // Qty. to Invoice from Qty. to Ship on its own — the PATCH response shows invoiceQty following
  // shipQty — which is precisely why the old shipAndInvoice path invoiced lines nobody asked it to.)
  for (const line of toShip) {
    bcToken = await getBcToken(bcCfg);
    const r = await patchSalesLine(base, bcToken, companyId, line.lineId, { shipQuantity: line.quantity });
    console.log(`  PATCHed ${soNumber} ${line.label}: pending shipQty=${r['shipQuantity']} invoiceQty=${r['invoiceQuantity']} (invoice qty left as-is)`);
  }

  // Snapshot the order's posted shipments so the one this run creates can be identified by
  // difference — replaces matching on the synthetic External Document No. ref we no longer stamp.
  bcToken = await getBcToken(bcCfg);
  const shipmentsBefore = await shipmentNosForOrder(bcCfg, bcToken, companyId, soNumber);

  console.log(`[pull] ${soNumber}: POST bmiSalesOrders/postShipment (ship-only)...`);
  bcToken = await getBcToken(bcCfg);
  try {
    await postShipmentOnly(bcCfg, bcToken, companyId, soNumber);
  } catch (err) {
    // A thrown post does NOT mean nothing was posted. BC commits the shipment inside Sales-Post
    // and can then fail on the way out — observed three times live, where the shipment (SLSS846339,
    // SLSS846354, SLSS846360) existed with shipped qty correct while the call returned
    //   HTTP 403 (TableData 50008 ESalesHeader Modify: PK_BC_customization)
    // Treating that as failure is actively harmful: the caller reports a desync for work that
    // succeeded, and /logs fills with red that hides the failures that ARE real.
    //
    // So ask BC what actually happened rather than trusting the exception. A new posted shipment
    // means the work landed — carry on and let the tracking write-back run against it. No new
    // shipment means the post genuinely failed, and the error is rethrown untouched.
    const e = err as AxiosError;
    bcToken = await getBcToken(bcCfg);
    const afterErr = await shipmentNosForOrder(bcCfg, bcToken, companyId, soNumber);
    const madeIt = [...afterErr].filter((n) => !shipmentsBefore.has(n));
    if (madeIt.length === 0) throw err;
    const msg = `post returned HTTP ${e.response?.status ?? '?'} but BC posted ${madeIt.join(',')} anyway — treating as posted`;
    console.warn(`[pull] ${soNumber}: ⚠ ${msg}`);
    await logEvent({ runId, worker: 'co', direction: 'deposco->bc', entityType: 'order', entityId: soNumber,
                     action: 'pull', status: 'desync', side: 'bc', message: msg,
                     detail: JSON.stringify(e.response?.data ?? e.message).slice(0, 2000),
                     dedupeKey: dailyDedupe('co-post-threw', soNumber, msg) });
  }

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
  // Identify the shipment this run created: whatever is on the order now that wasn't before.
  // Exact even when an order ships several times, and needs no ref stamped on the customer's PO
  // field. If it comes back ambiguous (or empty, e.g. another process posted concurrently), fall
  // through to the tracking backfill path rather than annotating the wrong document.
  bcToken = await getBcToken(bcCfg);
  const shipmentsAfter = await shipmentNosForOrder(bcCfg, bcToken, companyId, soNumber);
  const created = [...shipmentsAfter].filter((n) => !shipmentsBefore.has(n));
  const postedShipmentNo = created.length === 1 ? created[0] : null;
  if (created.length !== 1) {
    console.warn(`[pull] ${soNumber}: ⚠ expected exactly 1 new posted shipment, saw ${created.length} [${created.join(',') || 'none'}] — tracking falls back to backfill`);
  }
  console.log(`[pull] ${soNumber}: ✓ shipment posted (ship-only${postedShipmentNo ? `, ${postedShipmentNo}` : ''})`);

  // Stamp Deposco tracking onto the shipment we just posted, matched on its number.
  await writeTrackingBack(bcCfg, deposcoCfg, soNumber, postedShipmentNo, orderId, runId);
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
  /** Posted shipment (SLSS…) this run created, or null to backfill an untracked one. Was the
   *  synthetic `SHIP-{soNo}-{epoch}` External Document No. ref until that stamp was removed for
   *  clobbering the customer's PO number — the caller now diffs the order's shipments instead. */
  postedShipmentNo: string | null,
  customerOrderId: number,
  runId: number | null = null,
): Promise<void> {
  const logTrack = (status: 'ok' | 'skip' | 'fail', message: string, detail?: unknown, side: 'bc' | 'deposco' = 'bc') =>
    logEvent({ runId, worker: 'co', direction: 'deposco->bc', entityType: 'shipment',
               entityId: soNumber, action: 'tracking', status, side, message, detail,
               dedupeKey: dailyDedupe('co-track', `${soNumber}:${postedShipmentNo ?? 'backfill'}`, message) });

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

    // Backfill mode (caller didn't identify a shipment): target posted shipments of this SO that
    // still have no tracking. Ambiguous when several qualify — bail rather than guess, since the
    // wrong tracking number on a real shipment is worse than none.
    let targetShipmentNo: string | null = postedShipmentNo;
    if (!postedShipmentNo) {
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
    // Always keyed on the posted shipment number now — either the one the caller just created or
    // the single untracked one found above. The externalDocumentNo match the AL page also
    // supports is no longer used from here, since nothing stamps a ref to match on.
    const payload = {
      shipmentNo: targetShipmentNo,
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
                   { url: e.config?.url, postedShipmentNo }, side);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Shipment-driven pull: ask Deposco WHAT SHIPPED, instead of asking about every order
// ────────────────────────────────────────────────────────────────────────────
//
// The pull used to run inside the per-order loop: for all ~1,278 open sales orders, ask Deposco
// whether that one had shipped. ~3,800 calls a lap against an account-wide 4/sec ceiling, almost
// all of them answered "no" — that is what was producing the 429s, and 429s were dropping pushes.
//
// Deposco can just list its shipments (see fetchOutboundShipments): 3 calls returns every
// shipment it has, each linked to the fulfillment salesOrder, which carries the BC order number.
// So we let Deposco name the orders that need posting and touch only those. Same executor
// (pullShipmentsForSo) — only the SELECTION changed, so the delta/idempotency behaviour is
// unchanged and this stays safe to re-run.
//
// It also closes two holes the BC-driven sweep had by construction:
//   - an order reopened to Status=Open was invisible to a Released-only scan even though Deposco
//     had shipped it (~68 orders currently sit Open with WESTERLY lines);
//   - tracking added by Deposco AFTER the shipment posted never came back, because nothing in BC
//     changed to bring the order back into scope.
//
// Cursor: highest shipment NUMBER processed (sequential, same numeric discipline as everywhere
// else). RECHECK re-reads the newest few regardless, so a tracking number or extra quantity added
// to an already-seen shipment is still picked up.
const SHIPMENT_RECHECK = parseInt(process.env.SO_SHIPMENT_RECHECK ?? '100', 10);

async function pullFromShipments(bcCfg: BcConfig, deposcoCfg: DeposcoConfig, runId: number | null): Promise<void> {
  const dToken = await getDeposcoToken(deposcoCfg);
  const shipments = await fetchOutboundShipments(deposcoCfg, dToken);
  if (shipments.length === 0) { console.log('[ship] Deposco reported no outbound shipments'); return; }

  const cursorRaw = await readCursor('co', 'shipments');
  const cursor = Number(cursorRaw ?? 0) || 0;
  const seenUpdatedAt = await readCursor('co', 'shipments-updated');
  const highest = Math.max(...shipments.map((s) => s.number));

  // A shipment becomes due three ways. The point is to catch work that arrives WITHOUT the
  // shipment being new — most importantly a tracking number Deposco attaches minutes or hours
  // after the shipment itself, which is the case the old backfill existed for.
  //   1. number > cursor          — genuinely new since the last sweep
  //   2. updatedDate > last sweep — Deposco TOUCHED it since we last looked, at any age. This is
  //      the wide net, and it costs nothing: updatedDate is already in the list we just read.
  //      (Filtering on a Deposco-side date is fine — it's their own change stamp, not a BC
  //      business date that a user can backdate.)
  //   3. within the trailing RECHECK window — belt and braces for anything whose updatedDate
  //      doesn't move when it should.
  const recheckFloor = highest - SHIPMENT_RECHECK;
  const due = shipments.filter((s) =>
    s.number > cursor
    || s.number > recheckFloor
    || (seenUpdatedAt !== null && s.updatedDate !== '' && s.updatedDate > seenUpdatedAt));
  const newestUpdated = shipments.reduce((m, s) => (s.updatedDate > m ? s.updatedDate : m), '');
  console.log(`[ship] ${shipments.length} shipment(s), highest #${highest}, cursor #${cursor}, updated-since ${seenUpdatedAt ?? '(none)'} → ${due.length} to check`);
  if (due.length === 0) return;

  const byOrder = await resolveCustomerOrderNumbers(deposcoCfg, dToken, due.flatMap((s) => s.salesOrderIds));
  const orderNos = [...new Set([...byOrder.values()])].sort();
  if (orderNos.length === 0) { console.warn('[ship] no BC order numbers resolved from those shipments'); return; }
  console.log(`[ship] ${orderNos.length} BC order(s) with shipment activity: ${orderNos.join(', ')}`);

  let posted = 0, failed = 0;
  for (const soNumber of orderNos) {
    try {
      await pullShipmentsForSo(bcCfg, deposcoCfg, soNumber, runId);
      posted++;
    } catch (err) {
      const e = err as AxiosError;
      const body = JSON.stringify(e.response?.data ?? (err as Error).message);
      const side = e.response?.status === 429 || /EOM|not subscribed|deposco/i.test(body) ? 'deposco' : 'bc';
      console.error(`[ship] ${soNumber} pull FAILED HTTP ${e.response?.status}: ${body.slice(0, 400)}`);
      failed++;
      const msg = `shipment-driven pull: HTTP ${e.response?.status ?? '?'}: ${body.slice(0, 300)}`;
      await logEvent({ runId, worker: 'co', direction: 'deposco->bc', entityType: 'order', entityId: soNumber, action: 'pull', status: 'fail', side, message: msg, detail: body.slice(0, 4000), dedupeKey: dailyDedupe('co-ship-pull', soNumber, msg) });
    }
  }
  // Only advance past shipments whose orders all got a clean pass; a failure leaves both marks so
  // the shipment is reconsidered next tick (the recheck window covers it either way).
  // The updated-watermark is the newest updatedDate we SAW, not "now": Deposco stamps these, and
  // using our own clock would skip anything updated during the sweep or across clock skew.
  if (failed === 0) {
    await writeCursor('co', 'shipments', String(highest));
    if (newestUpdated) await writeCursor('co', 'shipments-updated', newestUpdated);
  }
  console.log(`[ship] done — ${posted} order(s) pulled, ${failed} failed, cursor ${failed === 0 ? `→ #${highest} / updated ${newestUpdated}` : `held at #${cursor}`}`);
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
    let batch: ScanBatch;
    // Rotation position per prefix, so a quiet PKSO can't drag the busy WSOD lap backwards.
    const cursor = CURSOR_ENABLED ? await readCursor('co', prefix) : null;
    try {
      batch = await listOrdersToSync(odata, bcToken, prefix, PER_PREFIX, cursor);
      sos = batch.rows;
    } catch (err) {
      // Must reach the DB, not just stdout. When this threw on a bad cursor the tick skipped the
      // whole prefix silently — /logs showed a clean run with zero pushes, and nobody could tell
      // that every sales order was being ignored.
      const e = err as AxiosError;
      const detail = JSON.stringify(e.response?.data ?? e.message).slice(0, 600);
      const msg = `CANDIDATE LIST FAILED (HTTP ${e.response?.status ?? '?'}) — NO orders were synced for ${prefix} this tick: ${detail.slice(0, 200)}`;
      console.error(`[tick] ${prefix}: ${msg}`);
      await logEvent({ runId, worker: 'co', direction: 'bc->deposco', entityType: 'order', entityId: `(${prefix} list)`, action: 'list', status: 'fail', side: 'bc', message: msg, detail, dedupeKey: dailyDedupe('co-list', prefix, msg) });
      fail++;
      continue;
    }
    console.log(`[tick] ${prefix}: ${sos.length} SO(s) [head+rotate from ${cursor || 'start'}]: ${sos.map((s) => pick(s, 'No')).join(', ') || '(none)'}`);
    for (const header of sos) {
      const soNumber = pick(header, 'No');
      try {
        const r = await pushSo(bcCfg, deposcoCfg, header, runId);
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
      // NOTE: no pull here any more. Asking Deposco about every order in the rotation was the
      // bulk of the Deposco traffic and nearly all of it returned "nothing shipped". The pull now
      // runs once per tick, driven by Deposco's own shipment list — see pullFromShipments below.
    }

    // Advance the rotation unconditionally, INCLUDING past failures. With a high-water mark that
    // would be wrong (a failed order would be skipped forever), but a rotation always comes back
    // round — so a failed order is retried next lap without stalling every order behind it on one
    // bad document. The failure itself is already recorded in sync_events.
    if (CURSOR_ENABLED) {
      await writeCursor('co', prefix, batch.nextCursor);
      console.log(`[tick] ${prefix}: rotation → ${batch.wrapped ? 'end of set, next lap starts from the beginning' : `resumes above ${batch.nextCursor}`}`);
    }
  }

  // One shipment-driven pull for the whole tick, after the pushes.
  if (PULL_ENABLED) {
    try {
      await pullFromShipments(bcCfg, deposcoCfg, runId);
    } catch (err) {
      const e = err as AxiosError;
      const body = JSON.stringify(e.response?.data ?? (err as Error).message);
      console.error(`[ship] shipment sweep FAILED HTTP ${e.response?.status}: ${body.slice(0, 400)}`);
      pullFail++;
      const msg = `shipment sweep: HTTP ${e.response?.status ?? '?'}: ${body.slice(0, 300)}`;
      await logEvent({ runId, worker: 'co', direction: 'deposco->bc', entityType: 'order', entityId: '(sweep)', action: 'pull', status: 'fail', side: 'deposco', message: msg, dedupeKey: dailyDedupe('co-ship-sweep', 'sweep', msg) });
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

    // --print-payload: build the customerOrder exactly as a push would and print it, WITHOUT
    // posting. For handing Deposco support a real request when they ask "what did you send us" —
    // this repo logs outcomes, not request bodies, so before this the only honest way to answer
    // was to re-post the order. Same builder as the live path, so it cannot drift from what the
    // worker actually sends. It prints the current code's output for that order, which is not
    // necessarily byte-identical to what was sent historically if the payload has changed since.
    if (process.argv.includes('--print-payload')) {
      const lines = await getSoLines(odata, token, orderArg);
      const payload = buildCustomerOrder(header, lines);
      console.log(`POST ${deposcoCfg.apiBase}/orders/customerOrders`);
      console.log('Content-Type: application/json');
      console.log('Authorization: Bearer <redacted>\n');
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

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
