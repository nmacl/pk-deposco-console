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
 *   node dist/to/sync-to.js --once                   one tick (Released transfers only)
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
import { postDeposcoOrder, lookupDeposcoOrderId, fetchReceivedFromPurchaseOrder, fetchShippedFromFulfillment, ensureItemsExist } from '../sync/orders.js';
import { startRun, finishRun, logEvent, closeDb, dailyDedupe } from '../sync/db-log.js';

const INTERVAL_MS = parseInt(process.env.TO_SYNC_INTERVAL_MS ?? '60000', 10);
const PREFIX = process.env.TO_PREFIX ?? 'TRFO';
// Cover the WHOLE open backlog, not a newest-N slice. 53 Released transfers against $top=25 left
// 28 invisible to every tick, permanently. Widening is safe HERE because a transfer leaves the
// Transfer Header table once fully posted, so this list self-drains — unlike sales orders, where
// Released is permanent and the equivalent set is 1,278.
const PER_TICK = parseInt(process.env.TO_PER_TICK ?? '250', 10);
// BC transfer posting is a heavyweight operation (item ledger + reservation entries) and blows
// past the 30s default on larger orders — seen live as ECONNABORTED on TRFO001688.
const POST_TIMEOUT_MS = parseInt(process.env.TO_POST_TIMEOUT_MS ?? '180000', 10);
const PUSH_ENABLED = (process.env.TO_PUSH_ENABLED ?? 'false').toLowerCase() === 'true';
const POST_ENABLED = (process.env.TO_POST_ENABLED ?? 'false').toLowerCase() === 'true';
const BU = process.env.DEPOSCO_COMPANY || 'HIVE';
const TRADING_PARTNER = process.env.DEPOSCO_TRADING_PARTNER || 'CTPK068417';
const ORDER_SOURCE = process.env.DEPOSCO_ORDER_SOURCE ?? 'BusinessCentralOnline';
// Ship-side transfers inherit the source SO's ProgramID as orderSource (see sourceOrderShipping).
// The receive-side payload is a purchaseOrder and keeps ORDER_SOURCE — POs carry no ProgramID.
const ORDER_SOURCE_FROM_PROGRAM = (process.env.SO_ORDER_SOURCE_FROM_PROGRAM ?? 'true').toLowerCase() === 'true';
// Deposco caps shipToContact.firstName/lastName at 30 chars. 18/30 Released transfers ship to
// "East Providence Decoration (In-House)", whose split yields a 32-char lastName -> HTTP 400.
const DEPOSCO_NAME_MAX = 30;
const capName = (v: string): string => (v.length <= DEPOSCO_NAME_MAX ? v : v.slice(0, DEPOSCO_NAME_MAX).trim());
const WMS_LOCATIONS = new Set((process.env.TO_WMS_LOCATIONS ?? 'WESTERLY').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));

// BC routes internal shuttle legs under its own shipping-agent codes; Deposco only recognises its
// named ship vias, and an unmapped code goes over as literal garbage (a raw "TO_EP" is sitting on
// a live CO). Map code → Deposco name; extendable via TO_SHIPVIA_MAP='CODE=Name,CODE=Name'.
const SHIPVIA_MAP = new Map<string, string>([
  ['TO_WSTRLY', 'Westerly Shuttle'],
  ['TO_EP', 'East Providence Shuttle'],
]);
for (const pair of (process.env.TO_SHIPVIA_MAP ?? '').split(',')) {
  const [code, name] = pair.split('=').map((s) => s.trim());
  if (code && name) SHIPVIA_MAP.set(code.toUpperCase(), name);
}

const toDate = (iso: string): string => (iso && iso !== '0001-01-01' ? iso.slice(0, 10) : '');
const toDateTime = (iso: string): string => { const d = toDate(iso); return d ? `${d}T00:00:00Z` : ''; };

// ── BC reads ─────────────────────────────────────────────────────────────────
// Transfer HEADERS come from our own bmiTransferHeaders API page (over the standard Transfer
// Header table) — NOT the OData `TransferOrders` web service, which prod refreshes wipe (404'd
// 2026-07-27). We adapt the camelCase API fields back to the OData-style keys the rest of the
// worker already reads via pick(header, 'Transfer_from_Code') etc., so nothing downstream changes.
interface BmiTransferHeader {
  no: string; status: string; directTransfer: boolean; fromCode: string; toCode: string;
  postingDate: string; receiptDate: string; shipmentDate: string;
  toName: string; toAddress: string; toAddress2: string; toCity: string; toCounty: string;
  toPostCode: string; toContact: string; toCountry: string;
}
function adaptTransferHeader(h: BmiTransferHeader): BcRow {
  return {
    No: h.no, Status: h.status, Direct_Transfer: String(h.directTransfer),
    Transfer_from_Code: h.fromCode, Transfer_to_Code: h.toCode,
    Posting_Date: h.postingDate, Receipt_Date: h.receiptDate, Shipment_Date: h.shipmentDate,
    Transfer_to_Name: h.toName, Transfer_to_Address: h.toAddress, Transfer_to_Address_2: h.toAddress2,
    Transfer_to_City: h.toCity, Transfer_to_County: h.toCounty, Transfer_to_Post_Code: h.toPostCode,
    Transfer_to_Contact: h.toContact, Trsf_to_Country_Region_Code: h.toCountry,
  };
}

async function listRecentTransferOrders(cfg: SyncBcConfig, companyId: string, token: string): Promise<BcRow[]> {
  // Open transfer orders can still be edited. Only Released transfers are ready for WMS export.
  const filter = encodeURIComponent(`startswith(no,'${odataStr(PREFIX)}') and status eq 'Released'`);
  // Order by document NUMBER, not postingDate. postingDate is a business date the user can set
  // to anything — a backdated transfer sorts into the middle of the list and is invisible from
  // the moment it's created, no matter how new it is (TRFO001666 ranked 49th of 53 on day one).
  // `no` is sequential and monotonic with creation, so ascending = oldest-outstanding first:
  // if the cap is ever hit, the most overdue work goes first instead of being starved forever.
  const url = `${bmiApiBase(cfg)}/companies(${companyId})/bmiTransferHeaders?$filter=${filter}&$orderby=no asc&$top=${PER_TICK}`;
  const rows = (await authReq<{ value: BmiTransferHeader[] }>('get', url, token)).value ?? [];
  // A full page means there may be more we never looked at. Silent truncation is what made this
  // a year-long invisible bug; say it out loud.
  if (rows.length >= PER_TICK) console.warn(`[tick] ⚠ hit the ${PER_TICK}-order cap — there may be Released transfers this tick never saw. Raise TO_PER_TICK.`);
  return rows.map(adaptTransferHeader);
}

async function getTransferOrder(cfg: SyncBcConfig, companyId: string, token: string, toNumber: string): Promise<BcRow | null> {
  const url = `${bmiApiBase(cfg)}/companies(${companyId})/bmiTransferHeaders?$filter=${encodeURIComponent(`no eq '${odataStr(toNumber)}'`)}`;
  const h = (await authReq<{ value: BmiTransferHeader[] }>('get', url, token)).value?.[0];
  return h ? adaptTransferHeader(h) : null;
}

// OData transfer lines — carries @odata.etag + posted quantities, needed for the write-back PATCH.
async function getTransferLines(odata: string, token: string, toNumber: string): Promise<BcRow[]> {
  const url = `${odata}/TransferOrderLines?$filter=${encodeURIComponent(`Document_No eq '${odataStr(toNumber)}'`)}`;
  return (await bcGet<{ value: BcRow[] }>(url, token, { Prefer: 'odata.maxpagesize=5000' })).value ?? [];
}

// Flattened lines from our sibling extension (webshopVariantCode in one GET) — for the Deposco push.
interface BmiToLine { lineNo: number; itemNo: string; variantCode: string; webshopVariantCode: string; quantity: number; }
async function getBmiTransferLines(cfg: SyncBcConfig, companyId: string, toNumber: string): Promise<BmiToLine[]> {
  const token = await getBcToken(cfg);
  const filter = encodeURIComponent(`documentNo eq '${odataStr(toNumber)}'`);
  const url = `${bmiApiBase(cfg)}/companies(${companyId})/bmiTransferOrderLines?$filter=${filter}`;
  const lines = (await authReq<{ value: BmiToLine[] }>('get', url, token)).value ?? [];
  // UPG's PK_BC18_TAB populates WebshopVariantCode on purchase/sales lines but NOT on transfer
  // lines (field 50201 comes back blank — e.g. TRFO001523). The mapping still exists at the
  // Item Variant level, so when a line has a BC variantCode but no webshop code, resolve it from
  // bmiItemVariants (itemNo + variantCode). Keeps TO pushes working regardless of UPG's gap.
  const needs = lines.filter((l) => !l.webshopVariantCode && l.itemNo && l.variantCode);
  if (needs.length) {
    const byItem = new Map<string, Map<string, string>>();
    for (const itemNo of new Set(needs.map((l) => l.itemNo))) {
      const vurl = `${bmiApiBase(cfg)}/companies(${companyId})/bmiItemVariants?$filter=${encodeURIComponent(`itemNo eq '${odataStr(itemNo)}'`)}`;
      const vs = (await authReq<{ value: { code: string; webshopVariantCode: string }[] }>('get', vurl, token)).value ?? [];
      byItem.set(itemNo, new Map(vs.filter((v) => v.webshopVariantCode).map((v) => [String(v.code).toUpperCase(), v.webshopVariantCode])));
    }
    let filled = 0;
    for (const l of needs) {
      const code = byItem.get(l.itemNo)?.get(String(l.variantCode).toUpperCase());
      if (code) { l.webshopVariantCode = code; filled++; }
    }
    if (filled) console.log(`[to] ${toNumber}: resolved ${filled}/${needs.length} webshopVariantCode(s) from Item Variant (transfer-line field was blank)`);
  }
  return lines;
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
// programId rides along because it comes off the SAME source-SO fetch — a transfer has no
// ProgramID of its own, so the ship-side CO inherits the source order's programme code.
interface ShipInfo { shipVia: string; shipVendor: string; freightTermsType: string; programId: string }
async function sourceOrderShipping(odata: string, token: string, sourceNo: string): Promise<ShipInfo | null> {
  if (!sourceNo) return null;
  const so = (await bcGet<{ value: BcRow[] }>(`${odata}/Sales_Order?$filter=${encodeURIComponent(`No eq '${odataStr(sourceNo)}'`)}`, token)).value?.[0];
  if (!so) return null;
  const agent = pick(so, 'Shipping_Agent_Code');
  const service = pick(so, 'Shipping_Agent_Service_Code');
  // A mapped shuttle code becomes its Deposco name and carries no vendor (shuttles have none);
  // anything else keeps the raw "AGENT SERVICE" form Deposco already accepts for carriers.
  const mapped = SHIPVIA_MAP.get(agent.toUpperCase());
  return {
    shipVendor: mapped ? '' : agent,
    shipVia: mapped ?? [agent, service].filter(Boolean).join(' '),
    freightTermsType: pick(so, 'LAX_Shipping_Payment_Type') || 'Prepaid',
    programId: pick(so, 'ProgramID', 'ProgramId').trim(),
  };
}

// Fallback when the transfer has no source SO: shuttle transfers carry the agent on their OWN
// lines (TRFO001798 → FEHIVE had TO_WSTRLY and no SO at all, so its CO went over with no ship
// via and parked in review). Only a MAPPED agent produces ShipInfo — an unmapped code (FEDEX)
// falls through to the old no-ship-info path rather than leaking a BC code into Deposco.
async function transferLineShipping(odata: string, token: string, no: string): Promise<ShipInfo | null> {
  try {
    for (const l of await getTransferLines(odata, token, no)) {
      const mapped = SHIPVIA_MAP.get(pick(l, 'Shipping_Agent_Code').toUpperCase());
      if (mapped) return { shipVia: mapped, shipVendor: '', freightTermsType: 'Prepaid', programId: '' };
    }
  } catch { /* the OData lines feed vanishes after prod refreshes — degrade to no ship info */ }
  return null;
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
      // Programme code from the source sales order; ORDER_SOURCE when there's no source SO.
      orderSource: (ORDER_SOURCE_FROM_PROGRAM && ship?.programId) || ORDER_SOURCE,
      placedDate: toDateTime(pick(header, 'Posting_Date', 'Order_Date')),
      ...(ship?.shipVia ? { shipVia: ship.shipVia } : {}),
      ...(ship?.shipVendor ? { shipVendor: ship.shipVendor } : {}),
      ...(ship ? { freightTermsType: ship.freightTermsType } : {}),
      shipToContact: {
        attention: pick(header, 'Transfer_to_Contact', 'Transfer_to_Name'),
        // Deposco caps these at 30; a long destination name overflows the split (see NAME_MAX).
        firstName: capName(parts[0] || name || 'N/A'),
        lastName: capName(parts.slice(1).join(' ') || parts[0] || 'N/A'),
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

// Skip a customerOrder push if Deposco already has a LIVE one (CO POST doesn't upsert — it
// dupes). liveOnly: copies that are ALL cancelled count as absent, so cancelling a bad transfer
// CO in Deposco lets the next tick push a clean replacement — the same remediation path the CO
// worker uses (proven on DISO210970). Any non-cancelled copy still blocks the push.
async function customerOrderExists(deposcoCfg: DeposcoConfig, externalOrderNumber: string): Promise<boolean> {
  const token = await getDeposcoToken(deposcoCfg);
  const id = await lookupDeposcoOrderId(deposcoCfg, token, '/orders/customerOrders', { externalOrderNumber }, { liveOnly: true });
  return id !== null;
}

// Outcome of a push attempt — so the caller can log ok vs "nothing pushed" (a data problem)
// vs "already in Deposco" (a legit no-op), instead of blindly recording every attempt as ok.
type PushOutcome =
  | { kind: 'pushed'; lines: number }
  | { kind: 'exists' }                                             // CO already in Deposco, nothing new sent
  | { kind: 'notReleased'; status: string }
  | { kind: 'none'; attempted: number; noVariant: number; zeroQty: number }; // 0 pushable lines

async function pushTransfer(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, companyId: string, header: BcRow, plan: TransferPlan): Promise<PushOutcome> {
  const no = pick(header, 'No');
  // The batch query filters Released orders, but manual --order runs fetch by number. Keep the
  // status gate at the push boundary so an Open transfer cannot be sent to Deposco either way.
  const status = pick(header, 'Status');
  if (status !== 'Released') {
    console.log(`[push] ${no}: status '${status || '(unknown)'}' - not Released, skipping (only Released transfers push)`);
    return { kind: 'notReleased', status };
  }
  const asWhat = plan === 'receive' ? 'purchaseOrder' : plan === 'ship' ? 'customerOrder' : 'purchaseOrder + customerOrder';
  console.log(`[push] ${no}: reading BC transfer lines (bmiTransferOrderLines) → Deposco as ${asWhat}`);
  const raw = await getBmiTransferLines(cfg, companyId, no);
  const lines = pushableLines(raw, no);
  if (lines.length === 0) {
    const zeroQty = raw.filter((l) => l.quantity <= 0).length;
    const noVariant = raw.filter((l) => l.quantity > 0 && !l.webshopVariantCode).length;
    console.warn(`[push] ${no}: ⚠ 0 pushable line(s) — NOTHING sent to Deposco (${noVariant} missing WebshopVariantCode, ${zeroQty} zero-qty, of ${raw.length})`);
    return { kind: 'none', attempted: raw.length, noVariant, zeroQty };
  }
  for (const l of lines) console.log(`  L${l.lineNo} item=${l.itemNo} → ${l.webshopVariantCode} qty=${l.quantity}`);

  let posted = 0;
  if (plan === 'receive' || plan === 'both') {
    await postDeposcoOrder(cfg, deposcoCfg, '/orders/purchaseOrders', buildTransferAsPurchaseOrder(header, lines), no, `${lines.length} line(s) as PO (receive)`, { worker: 'to' });
    posted++;
  }
  if (plan === 'ship' || plan === 'both') {
    if (await customerOrderExists(deposcoCfg, no)) {
      console.log(`[push] ${no}: customerOrder already in Deposco — skipping create (no upsert)`);
    } else {
      // A mapped shuttle agent on the transfer's OWN lines describes how THIS leg physically
      // moves and beats the source SO's customer carrier — every shuttle transfer pushed with
      // the SO's FEDEX has been hand-corrected to "… Shuttle" in Deposco (the whole completed
      // EPDEC batch, TRFO001759/001806). The source SO still supplies ship-via when the lines
      // carry no mapped agent, and is always the only source of programId.
      const sourceNo = pick(header, 'PKSourceNo', 'Transfer_to_Contact');
      const soShip = await sourceOrderShipping(bcOdataBase(cfg), await getBcToken(cfg), sourceNo);
      const lineShip = await transferLineShipping(bcOdataBase(cfg), await getBcToken(cfg), no);
      const ship = lineShip ? { ...lineShip, programId: soShip?.programId ?? '' } : soShip;
      if (!ship) console.warn(`[push] ${no}: no source SO shipping and no mapped line agent (source=${sourceNo || 'none'}) — CO may land in review`);
      // Pre-flight: CO creates with unknown items land unlinked and unrepairable (see ensureItemsExist).
      const preCreated = await ensureItemsExist(cfg, deposcoCfg, await getDeposcoToken(deposcoCfg), lines.map((l) => l.webshopVariantCode));
      if (preCreated.length) console.log(`[push] ${no}: pre-created ${preCreated.length} missing item(s): ${preCreated.join(', ')}`);
      await postDeposcoOrder(cfg, deposcoCfg, '/orders/customerOrders', buildTransferAsCustomerOrder(header, lines, ship), no, `${lines.length} line(s) as CO (ship)${ship ? `, via ${ship.shipVia}${ship.programId ? `, program ${ship.programId}` : ''}` : ''}`, { worker: 'to' });
      posted++;
    }
  }
  return posted > 0 ? { kind: 'pushed', lines: lines.length } : { kind: 'exists' };
}


// ── Pull Deposco → BC: post the shipment and/or receipt to match what Deposco confirmed ──
// The bmi post actions are always available; we just post the leg(s) needed:
//   receive (X→WMS): Deposco RECEIVED it → post the origin shipment (into transit) AND the receipt.
//   ship    (WMS→X): Deposco SHIPPED it  → post the shipment; a DIRECT transfer also receives.
// Direct = all-or-nothing (BC requires the full line qty); non-direct = post the delta.

// Resolve the TO's SystemId on the bmi page and POST the bound ship/receive action.
// Returns the posted BC document no. (or null if the order wasn't on the page).
async function bmiPost(cfg: SyncBcConfig, companyId: string, no: string, action: 'postShipment' | 'postReceipt', token: string): Promise<string | null> {
  const bmi = `${bmiApiBase(cfg)}/companies(${companyId})`;
  const order = (await authReq<{ value: Array<{ systemId: string }> }>('get',
    `${bmi}/bmiTransferOrders?$filter=${encodeURIComponent(`no eq '${odataStr(no)}'`)}`, token)).value?.[0];
  if (!order) { console.warn(`[pull] ${no}: not on bmiTransferOrders page — cannot ${action}`); return null; }
  // Posting a transfer in BC writes item ledger + reservation entries; on a many-line order it
  // routinely runs past the 30s default and came back ECONNABORTED, so the post was never
  // confirmed even when BC completed it. Give it room.
  //
  // Deliberately NOT retried on timeout: a POST that timed out may well have posted, and firing
  // it again would double-ship. It's safe to just let it go — the next tick recomputes
  // delta = deposcoQty − bcPostedQty, so a post that did land shows up as delta 0 and a post
  // that didn't gets retried from scratch. The loop is self-correcting; a blind retry is not.
  const doc = await authReq<string>('post', `${bmi}/bmiTransferOrders(${order.systemId})/Microsoft.NAV.${action}`, token,
    { data: {}, timeout: POST_TIMEOUT_MS });
  const posted = typeof doc === 'object' && doc && 'value' in (doc as Record<string, unknown>) ? (doc as { value: unknown }).value : doc;
  console.log(`[pull] ${no}: ✅ ${action} → BC doc ${JSON.stringify(posted)}`);
  return posted == null ? '' : String(posted);
}

// A leg that actually posted — carried up to the tick so success lands in sync_events, not just
// stdout (a fully-posted transfer used to vanish from BC with zero trace in /logs).
interface PostedLeg { action: 'postShipment' | 'postReceipt'; staged: number; doc: string | null }

// Post one leg: PATCH each line's qty up to the Deposco-confirmed target, then fire the action.
// Returns the posted leg, or null when nothing was outstanding (in sync — the common case).
async function postLeg(cfg: SyncBcConfig, companyId: string, no: string, action: 'postShipment' | 'postReceipt', qtyField: 'Qty_to_Ship' | 'Qty_to_Receive', postedField: 'Quantity_Shipped' | 'Quantity_Received', confirmed: Map<number, number>, direct: boolean): Promise<PostedLeg | null> {
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
  if (staged === 0) { console.log(`[pull] ${no}: ${action} — nothing to post (in sync)`); return null; }
  console.log(`[pull] ${no}: ${action} — staged ${staged} unit(s)`);
  const doc = await bmiPost(cfg, companyId, no, action, token);
  return { action, staged, doc };
}

async function pull(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, companyId: string, header: BcRow, plan: TransferPlan, direct: boolean): Promise<PostedLeg[]> {
  const no = pick(header, 'No');
  const dToken = await getDeposcoToken(deposcoCfg);
  const legs: PostedLeg[] = [];

  if (plan === 'receive' || plan === 'both') {
    const poId = await lookupDeposcoOrderId(deposcoCfg, dToken, '/orders/purchaseOrders', { number: no });
    if (poId === null) { console.log(`[pull] ${no}: not in Deposco (purchaseOrder) yet — skip receive`); return legs; }
    const recv = new Map<number, number>();
    const received = await fetchReceivedFromPurchaseOrder(deposcoCfg, dToken, poId);
    if (received.truncated) console.error(`[pull] ${no}: ❌ Deposco truncated the PO line list (>10 lines) — received qty beyond the first page is unreadable and will NOT post. Post the remainder manually.`);
    for (const r of received.lines) recv.set(r.line, (recv.get(r.line) ?? 0) + r.quantity);
    console.log(`[pull] ${no}: RECEIVE — Deposco received ${[...recv].map(([k, v]) => `L${k}=${v}`).join(' ') || '(none)'}`);
    // Origin doesn't post its own shipment, so post it (→ in transit) then receive — both to the received qty.
    const shipLeg = await postLeg(cfg, companyId, no, 'postShipment', 'Qty_to_Ship', 'Quantity_Shipped', recv, direct);
    if (shipLeg) legs.push(shipLeg);
    const recvLeg = await postLeg(cfg, companyId, no, 'postReceipt', 'Qty_to_Receive', 'Quantity_Received', recv, direct);
    if (recvLeg) legs.push(recvLeg);
  } else if (plan === 'ship') {
    const coId = await lookupDeposcoOrderId(deposcoCfg, dToken, '/orders/customerOrders', { externalOrderNumber: no });
    if (coId === null) { console.log(`[pull] ${no}: not in Deposco (customerOrder) yet — skip ship`); return legs; }
    const shipped = new Map<number, number>();
    const ship = await fetchShippedFromFulfillment(deposcoCfg, dToken, coId);
    if (ship.truncatedOrders.length > 0) console.error(`[pull] ${no}: ❌ Deposco truncated the line list on ${ship.truncatedOrders.join(', ')} (>10 lines) — shipped qty beyond the first page is unreadable and will NOT post. Post the remainder manually.`);
    for (const l of ship.lines) {
      const ln = parseInt(l.externalLineNumber ?? '', 10);
      if (Number.isFinite(ln)) shipped.set(ln, (shipped.get(ln) ?? 0) + Number(l.shippedQuantity ?? 0));
    }
    console.log(`[pull] ${no}: SHIP — Deposco shipped ${[...shipped].map(([k, v]) => `L${k}=${v}`).join(' ') || '(none)'}${direct ? ' (direct → ship+receive)' : ''}`);
    const shipLeg = await postLeg(cfg, companyId, no, 'postShipment', 'Qty_to_Ship', 'Quantity_Shipped', shipped, direct);
    if (shipLeg) legs.push(shipLeg);
    if (direct) {
      const recvLeg = await postLeg(cfg, companyId, no, 'postReceipt', 'Qty_to_Receive', 'Quantity_Received', shipped, direct);
      if (recvLeg) legs.push(recvLeg);
    }
  }
  return legs;
}

// ── Single-order sync (the web-UI button backend) + batch tick ──────────────
// postError carries a post-back failure out separately from a push failure: they have different
// causes (push = Deposco rejected us; post = BC rejected us) and lumping both into the tick's
// generic 'sync' event is what left a bare "404" in /logs with no hint that the OData
// TransferOrderLines page was the thing missing.
interface SyncResult { plan: TransferPlan; push?: PushOutcome; posted?: PostedLeg[]; postError?: { status?: number; body: string } }
async function syncOne(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig, companyId: string, header: BcRow, opts: { push: boolean; post: boolean }): Promise<SyncResult> {
  const no = pick(header, 'No');
  const from = pick(header, 'Transfer_from_Code').toUpperCase();
  const to = pick(header, 'Transfer_to_Code').toUpperCase();
  const plan = classify(header);
  if (plan === 'skip') { console.log(`[to] ${no}: ${from}→${to} not WMS-relevant — skip`); return { plan }; }
  const direct = pick(header, 'Direct_Transfer') === 'true';
  console.log(`[to] ${no}: ${from}→${to} → ${plan}${direct ? ' (direct)' : ''}`);

  let push: PushOutcome | undefined;
  if (opts.push) push = await pushTransfer(cfg, deposcoCfg, companyId, header, plan);
  let postError: SyncResult['postError'];
  let posted: PostedLeg[] | undefined;
  if (opts.post) {
    try {
      posted = await pull(cfg, deposcoCfg, companyId, header, plan, direct);
    } catch (err) {
      const e = err as AxiosError;
      const body = JSON.stringify(e.response?.data ?? e.message);
      const url = e.config?.url ? ` [${e.config.method?.toUpperCase()} ${e.config.url}]` : '';
      postError = { status: e.response?.status, body: `${body}${url}` };
      console.error(`[pull] ${no} post-back FAILED HTTP ${e.response?.status}${url}: ${body.slice(0, 500)}`);
    }
  }
  return { plan, push, posted, postError };
}


async function tick(cfg: SyncBcConfig, deposcoCfg: DeposcoConfig): Promise<void> {
  const token = await getBcToken(cfg);
  const companyId = await getCompanyId(cfg, token);
  // Run row first so a list failure (e.g. the TransferOrders OData web service missing after a
  // prod refresh — seen 2026-07-27) is visible in /logs instead of a silent early return.
  const runId = await startRun('to', process.env.SYNC_TRIGGER || 'manual');
  let orders: BcRow[];
  try {
    orders = await listRecentTransferOrders(cfg, companyId, token);
  } catch (err) {
    const e = err as AxiosError;
    const msg = `${e.response?.status ?? (e as Error).message} — TransferOrders OData feed (web service may be unpublished)`;
    console.error(`[tick] list FAILED: ${msg}`);
    await logEvent({ runId, worker: 'to', action: 'list', status: 'fail', side: 'bc', message: `list failed: ${msg}`, dedupeKey: dailyDedupe('to-list', PREFIX, msg) });
    await finishRun(runId, 'error', { posted: 0, failed: 1 });
    return;
  }
  console.log(`[tick] ${orders.length} transfer order(s)`);
  // push/post re-run every tick (upsert / post-what's-outstanding), so log FAILURES only;
  // the run row carries the processed/failed counts.
  let processed = 0, failed = 0, desynced = 0;
  for (const header of orders) {
    processed++;
    const no = pick(header, 'No');
    try {
      const { plan, push, posted, postError } = await syncOne(cfg, deposcoCfg, companyId, header, { push: PUSH_ENABLED, post: POST_ENABLED });
      if (postError) {
        failed++;
        const pmsg = `post-back to BC: HTTP ${postError.status ?? '?'}: ${postError.body.slice(0, 300)}`;
        await logEvent({ runId, worker: 'to', direction: 'deposco->bc', entityType: 'order', entityId: no, action: 'post', status: 'fail', side: 'bc', message: pmsg, detail: postError.body.slice(0, 4000), dedupeKey: dailyDedupe('to-post', no, pmsg) });
      }
      // Successful post-backs are the payoff of the whole worker — say so in /logs, not just
      // stdout. Keyed on the posted doc no. so each real posting logs exactly once and a later
      // posting of the same order (new delta, new doc) logs again.
      for (const leg of posted ?? []) {
        const what = leg.action === 'postShipment' ? 'shipment' : 'receipt';
        await logEvent({ runId, worker: 'to', direction: 'deposco->bc', entityType: 'order', entityId: no, action: 'post', status: 'ok', side: 'bc', message: `posted ${what}: ${leg.staged} unit(s)${leg.doc ? ` → ${leg.doc}` : ''}`, dedupeKey: dailyDedupe('to-post-ok', no, `${leg.action}:${leg.doc ?? leg.staged}`) });
      }
      if (plan === 'skip') {
        await logEvent({ runId, worker: 'to', direction: 'bc->deposco', entityType: 'order', entityId: no, action: 'sync', status: 'skip', message: 'not WMS-relevant', dedupeKey: dailyDedupe('to-skip', no, 'skip') });
      } else if (push?.kind === 'notReleased') {
        await logEvent({ runId, worker: 'to', direction: 'bc->deposco', entityType: 'order', entityId: no, action: 'push', status: 'skip', message: `status ${push.status || '(unknown)'}; only Released transfers push`, dedupeKey: dailyDedupe('to-status', no, push.status || 'unknown') });
      } else if (push?.kind === 'none') {
        // Classified as ship/receive but NOTHING was pushable — a real data problem (lines with no
        // WebshopVariantCode or 0 qty). Log as desync (surfaces under /logs "Issues"), not ok.
        desynced++;
        const msg = `0 pushable line(s) — NOTHING sent to Deposco (${push.noVariant} missing WebshopVariantCode, ${push.zeroQty} zero-qty, of ${push.attempted})`;
        console.warn(`[to] ${no}: ${msg}`);
        await logEvent({ runId, worker: 'to', direction: 'bc->deposco', entityType: 'order', entityId: no, action: 'push', status: 'desync', side: 'bc', message: msg, dedupeKey: dailyDedupe('to-nopush', no, msg) });
      } else if (push?.kind === 'exists') {
        await logEvent({ runId, worker: 'to', direction: 'bc->deposco', entityType: 'order', entityId: no, action: 'sync', status: 'skip', message: 'already in Deposco (no upsert)', dedupeKey: dailyDedupe('to-exists', no, 'exists') });
      } else {
        const extra = push?.kind === 'pushed' ? `, ${push.lines} line(s)` : '';
        await logEvent({ runId, worker: 'to', direction: 'bc->deposco', entityType: 'order', entityId: no, action: 'sync', status: 'ok', message: `synced (${plan})${extra}`, dedupeKey: dailyDedupe('to', no, `ok:${plan}`) });
      }
    } catch (err) {
      const e = err as AxiosError;
      const body = JSON.stringify(e.response?.data ?? e.message).slice(0, 300);
      // 429 bodies are empty, so the text match alone mislabelled rate limits as a BC fault.
      const side = e.response?.status === 429 || /EOM|not subscribed|deposco/i.test(body) ? 'deposco' : 'bc';
      console.error(`[to] ${pick(header, 'No')} FAILED HTTP ${e.response?.status}: ${body.slice(0, 400)}`);
      failed++;
      const tmsg = `HTTP ${e.response?.status}: ${body.slice(0, 180)}`;
      await logEvent({ runId, worker: 'to', direction: 'bc->deposco', entityType: 'order', entityId: pick(header, 'No'), action: 'sync', status: 'fail', side, message: tmsg, dedupeKey: dailyDedupe('to', pick(header, 'No'), tmsg) });
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

  // Single-order manual sync (web-UI button backend). Defaults to push + post; --push-only
  // / --post-only isolate the two halves (separate "sync to Deposco" vs "ship/receive" buttons).
  if (orderArg) {
    const pushOnly = process.argv.includes('--push-only');
    const postOnly = process.argv.includes('--post-only');
    const token = await getBcToken(cfg);
    const companyId = await getCompanyId(cfg, token);
    const header = await getTransferOrder(cfg, companyId, token, orderArg);
    if (!header) { console.error(`[to] ${orderArg}: not found`); process.exit(1); }
    const { push, postError } = await syncOne(cfg, deposcoCfg, companyId, header, { push: !postOnly, post: !pushOnly });
    // Exit 3 when a push was attempted but nothing was pushable, so the console button records it
    // as a desync (warning) instead of a green "ok". (0 / not-found = 1 / real error via throw.)
    if (push?.kind === 'none') { console.warn(`[to] ${orderArg}: nothing pushed — flagged as desync`); process.exit(3); }
    // pull() no longer throws out of syncOne, so exit non-zero here or the console button would
    // report a failed post-back as a green "ok".
    if (postError) { console.error(`[to] ${orderArg}: post-back failed — HTTP ${postError.status ?? '?'}`); process.exit(1); }
    return;
  }

  const once = process.argv.includes('--once');
  console.log(`[to-sync] starting — interval=${INTERVAL_MS}ms prefix=${PREFIX} perTick=${PER_TICK} push=${PUSH_ENABLED} post=${POST_ENABLED} wms=[${[...WMS_LOCATIONS].join(',')}]${once ? ' (single tick)' : ''}`);
  if (once) { await tick(cfg, deposcoCfg); await closeDb(); return; }
  for (;;) {
    const t0 = Date.now();
    try { await tick(cfg, deposcoCfg); } catch (err) { console.error('[tick] FAILED:', err instanceof Error ? err.message : err); }
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - t0)));
  }
}

main().catch((err) => { console.error('FATAL:', err instanceof Error ? err.message : err); process.exit(1); });
