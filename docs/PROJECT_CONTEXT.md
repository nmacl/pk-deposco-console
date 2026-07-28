# PK → Deposco Item Sync: Project Context

## What this is

Parsons Kellogg is migrating off a homegrown WMS to Deposco (project codename "HIVE"). Business Central stays as the system of record for items, customers, vendors, orders, finances. Deposco handles all warehouse execution.

There is no off-the-shelf BC↔Deposco connector. Deposco publishes connectors for D365 F&O and Dynamics GP but not Business Central. An earlier attempted integration used the OOB connector and dropped variant/custom field data — result is ~40,945 stub items currently sitting in Deposco's HIVE tenant with auto-generated `D######` numbers, sparse data, and no link back to BC. None have been transacted against, they're disposable.

## Phase 1 scope

Item sync only, one-way BC → Deposco. Everything else (trading partners, sales orders, ship notices, POs, receipts, returns, inventory adjustments) is later phases.

## What's validated

These have been tested live against the real Deposco tenant:

- **Deposco auth works.** OAuth2 client_credentials via Basic Auth → returns token.
- **Deposco API v2.0 URL pattern.** It's `https://api.deposco.com/latest/items` — no `/integration/{code}/` prefix. The integration is implicit in the auth token.
- **GET items works.** `GET /items` returns paginated items. Use `links.next.href` for pagination, not `?page=N`.
- **POST item works end-to-end.** A real test payload was POSTed and created `UL0A013LS-BLK-LG` (Deposco id 40948). Every field in the payload landed correctly. The reference payload below is that exact payload.

## What's NOT validated yet

- BC OData auth from Postman (we know the Entra app `PK-BC-OAuth` exists with client ID `44ee2db9-3d46-48cb-9b28-337c1c702867`, but the client secret needs to be retrieved from wherever pilot stored it)
- Bulk operations against Deposco
- Inactivate endpoint shape
- Anything against more than one item

## Connection details

### Deposco
- Auth URL: `https://auth.deposco.com/oauth2/token`
- API base: `https://api.deposco.com/latest`
- Auth pattern: Basic Auth (client_id:client_secret) + form body
- Form body params: `grant_type=client_credentials`, `scope=items/read items/write`, `env=releasesupport`, `company=HIVE`
- Do NOT include `businessUnitId` in the auth request (causes "Invalid business unit id" error)
- Token cached, expires in ~1 hour

### Business Central
- Base URL: `https://api.businesscentral.dynamics.com/v2.0/c93df08a-282d-4d69-b189-3b021ad6218e/PILOT/ODataV4/Company('Parsons-Kellogg')`
- Tenant ID: `c93df08a-282d-4d69-b189-3b021ad6218e`
- Environment: `PILOT` (not Production — this is the dev/test BC env)
- Entra app: Mulesoft connector (Client ID `5d0c10ea-19c0-411f-b595-76ae5285e664`)
- Token URL: `https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token`
- Scope: `https://api.businesscentral.dynamics.com/.default`

### Hive Pilot socket
- Deposco-side integration name: `Hive Pilot` (with the space)
- This is the value for `channels[0].integration.businessKey.name` on item create
- There's already a `scheduler` user pushing items through this socket from some other system (probably Dataverse based on GUID-shaped ref1 values). Don't worry about that for now — we're treating it as crap data to be wiped.

## BC source endpoints

Use these:
- `Item_Card_Excel` — standard BC Item Card, parent item master data
- `Item_Variants` — variant data including `WebshopVariantCode`
- `Item_Vendor_Catalog` — per-variant vendor numbers (for the future PO flow, not Phase 1)

Don't use these:
- `pbiitems`, `pbiitemvariants` — Power BI projections, slimmer than the standard endpoints, custom queries that could change
- `Item_Reference_Entries_Excel` — only contains vendor references, no UPC/barcode data
- Any `LAX_*` fields — Lanham Express extension, being sunsetted
- Legacy location fields (`Room`, `Aisle`, `Row`, `Bin`, `Overstock_*`) — homegrown WMS artifacts, abandoned

## Locked assumptions

### Identity
1. Deposco item `number` = BC `WebshopVariantCode` (e.g. `UL0A013LS-BLK-LG`)
2. If `WebshopVariantCode` is empty, fall back to `{Item_No}-{Variant_Code}`
3. For items with no variants, use `Item_No` directly

### Filtering
4. Skip phantom variants where `Item_No` is empty (these exist in the data)
5. Skip items where `Type` is not "Inventory" (skip service codes, charges, etc.)

### Channel listing
6. `feedName` / `integration.businessKey.name` = `"Hive Pilot"`
7. `ref1` = BC `Item_No`, `ref2` = BC `Variant_Code`, `ref3` = `"EA"`, `ref4` = `WebshopVariantCode`

### Field mapping
8. `name` = `Item_Card_Excel.Description`
9. `shortDescription` = `"{Brand} {Style} {Color} {Size}"` constructed
10. `longDescription` = `Item_Card_Excel.Description`
11. `brandName` = `Item_Card_Excel.Brand`
12. `styleNumber` and `styleName` = `Item_Card_Excel.Style`
13. `size` = `Item_Variants.Size`
14. `colorName` = `Item_Variants.Description_2`
15. `unitPrice` = `Item_Card_Excel.Unit_Price`
16. `purchaseCost` = `Item_Card_Excel.Last_Direct_Cost` (NOT `Unit_Cost` — unreliable)
17. `active` = `!Item_Card.Blocked && !Item_Variants.Block`
18. `salesEnabledFlag` = `!Item_Card.Sales_Blocked`
19. `shippable` = hardcoded `true`
20. `hazmat` = hardcoded `false`
21. `inventoryTrackingEnabled` = hardcoded `true` (ignore BC `Stock_Item` flag, unreliable)

### Packs
22. One pack per item: `type: "Each"`, `quantity: 1`
23. `newPackFlag: false` — **changed 2026-06-09 (PK ops).** Was `true`, but that made Deposco *force* weight/dimension capture at first receipt, which ops doesn't want on the master-data upload. Now `false`. (Revisit Monday — there may be more nuance.) Code: `src/phase1/transform.ts` `buildPack()`.
24. `weight` and `dimensions` sent as 0 (no real data in BC anyway)

### UPCs
25. Send UPC from `Item_Variants.UPC_GTN_No` as top-level `upcs.data[{ value }]` on the item. Omit the field entirely if empty. ~152k of 805k variants have a UPC.

### Existing data
26. The 40k `D######` stub items get bulk-deactivated separately. Not part of the sync logic.
27. No matching of old stubs to new items. Clean break.

## Master-data strategy: active-bin base set (decided 2026-06-09, PK ops)

**We do NOT push the full ~427k catalog as steady state.** Deposco only needs items we can actually transact against. Those come from two places:

1. **Base set = items we currently hold stock for**, read from BC bin contents.
2. **Lazy-load from POs** = inbound items not yet stocked, created on-demand at PO push time (to build — see TASK.md).

Between the two, every item Deposco needs is covered, and the catalog drops from ~427k to **~4,100**.

### Base set source — `Bin_Contents_Excel`

OData page: `…/ODataV4/Company('Parsons-Kellogg')/Bin_Contents_Excel`

- Filter: `Location_Code eq 'PK'` server-side, then **`ItemSubType in ('Blank','FG')` client-side**.
  - ⚠ Do NOT put `ItemSubType` in the server-side `$filter` — it's a computed field and the query socket-hangs-up (ECONNRESET). Pull PK rows (filtered only on location) and filter Blank/FG in JS.
- The bin row **already carries `WebshopVariantCode`** (= the Deposco item `number`), so no variant lookup is needed to get the item set. It also carries `Item_No`, `Variant_Code`, `ItemSubType`, `Quantity_Base` (on-hand), `Bin_Code`, `Brand`, `UPC_GTN_No`, `ItemDescription` (size).
- `Default` location is `PK` for now; ops will switch to a different location code later.

### Sizing (PILOT, 2026-06-09)

- PK bin rows: 26,163 → `Blank` 17,792, `Decorated` 7,488 (**excluded**), `FG` 883.
- Blank+FG distinct `WebshopVariantCode`: **4,101** (all assigned bins) / 2,363 (`Quantity_Base > 0` only).
- **Decision: use all 4,101 assigned bins**, not just on-hand>0 — a fixed-but-momentarily-empty bin is still stock we manage; we don't want items dropping out of Deposco on a transient zero.
- The base set is built **live from BC** (no cache, no transform exclusion filters), so all 4,101 resolve. On the Deposco push, **8 are rejected for duplicate UPC** (the same UPC is already on another item — a BC data issue; deferred), so **4,093 of 4,101 are in Deposco**.

### Scripts / artifacts (self-contained, repo root)

- `build-base.mjs` — **live from BC, no cache.** Pulls PK Blank/FG bin contents → distinct `WebshopVariantCode` (`output/base-numbers.txt`, 4,101), then batched live lookups of each variant (by `WebshopVariantCode`) + its item card → transform → `output/payloads-base.ndjson` (4,101 lines, `newPackFlag:false`). Bypasses the Phase-1 transform's letter/DNU/screen exclusion filters on purpose. No dependency on `payloads.ndjson` or the `raw/` variant cache (both deleted 2026-06-09).
- `check-txn.mjs <requestId>` — dump a Deposco async bulk-import transaction's created/updated/failed detail.
- Push: `PAYLOADS_FILE=output/payloads-base.ndjson AUDIT_FILE=output/base-audit.csv npm run bulk-import`. Importer now reports per-entity successes/failures honestly (it re-checks after Deposco flips Success→Partially Failed post-UPC-validation) and writes `<audit>-failures.csv`.

## Field mapping table

| Deposco field | BC source |
|---|---|
| `number` | `Item_Variants.WebshopVariantCode` (fallback: `{Item_No}-{Variant_Code}`) |
| `businessUnit.businessKey.code` | hardcoded `"HIVE"` |
| `name` | `Item_Card_Excel.Description` (parent) |
| `shortDescription` | constructed: `"{Brand} {Style} {Color} {Size}"` |
| `longDescription` | `Item_Card_Excel.Description` |
| `brandName` | `Item_Card_Excel.Brand` |
| `styleNumber` | `Item_Card_Excel.Style` |
| `styleName` | `Item_Card_Excel.Style` |
| `size` | `Item_Variants.Size` |
| `colorName` | `Item_Variants.Description_2` |
| `active` | `!Item_Card.Blocked && !Item_Variants.Block` |
| `salesEnabledFlag` | `!Item_Card.Sales_Blocked` |
| `shippable` | hardcoded `true` |
| `hazmat` | hardcoded `false` |
| `inventoryTrackingEnabled` | hardcoded `true` |
| `unitPrice` | `Item_Card_Excel.Unit_Price` |
| `purchaseCost` | `Item_Card_Excel.Last_Direct_Cost` |
| `packs[0].type` | hardcoded `"Each"` |
| `packs[0].quantity` | hardcoded `1` |
| `packs[0].newPackFlag` | hardcoded `true` |
| `packs[0].weight` | `{ weight: 0, units: "lb" }` |
| `packs[0].dimensions` | all zeros, `units: "in"` |
| `channels[0].integration.businessKey.name` | hardcoded `"Hive Pilot"` |
| `channels[0].listingStatus` | hardcoded `"Linked"` |
| `channels[0].saleable` | `!Item_Card.Sales_Blocked` |
| `channels[0].packQuantity` | hardcoded `1` |
| `channels[0].ref1` | `Item_Variants.Item_No` |
| `channels[0].ref2` | `Item_Variants.Code` |
| `channels[0].ref3` | hardcoded `"EA"` |
| `channels[0].ref4` | `Item_Variants.WebshopVariantCode` |

## Reference payload (validated working)

This was POSTed to `https://api.deposco.com/latest/items` and accepted. Match this shape exactly.

```json
{
  "number": "UL0A013LS-BLK-LG",
  "businessUnit": { "businessKey": { "code": "HIVE" } },
  "name": "Port Authority Men's Fine Stripe Performance Polo",
  "shortDescription": "PORT AUTHORITY UL0A013LS Black LG",
  "longDescription": "Port Authority Men's Fine Stripe Performance Polo",
  "active": true,
  "salesEnabledFlag": true,
  "shippable": true,
  "hazmat": false,
  "inventoryTrackingEnabled": true,
  "unitPrice": 25,
  "purchaseCost": 16.31,
  "packs": [
    {
      "type": "Each",
      "quantity": 1,
      "newPackFlag": true,
      "weight": { "weight": 0, "units": "lb" },
      "dimensions": {
        "length": { "measurement": 0, "units": "in" },
        "width": { "measurement": 0, "units": "in" },
        "height": { "measurement": 0, "units": "in" }
      }
    }
  ],
  "channels": [
    {
      "integration": { "businessKey": { "name": "Hive Pilot" } },
      "listingStatus": "Linked",
      "saleable": true,
      "packQuantity": 1,
      "ref1": "10000",
      "ref2": "00002",
      "ref3": "EA",
      "ref4": "UL0A013LS-BLK-LG"
    }
  ]
}
```

## Real BC data examples (for reference)

### Item Card row (parent item)
```json
{
  "No": "10000",
  "Description": "Port Authority Men's Fine Stripe Performance Polo",
  "Base_Unit_of_Measure": "EACH",
  "Brand": "PORT AUTHORITY",
  "Style": "UL0A013LS",
  "Unit_Price": 25,
  "Unit_Cost": 38,
  "Last_Direct_Cost": 16.31,
  "Blocked": false,
  "Sales_Blocked": false,
  "Type": "Inventory",
  "Last_Date_Modified": "2025-09-17"
}
```

### Item Variant row (variant under parent)
```json
{
  "Item_No": "10000",
  "Code": "00002",
  "Description": "LG",
  "Description_2": "Black",
  "Block": false,
  "Brand": "PORT AUTHORITY",
  "WebshopVariantCode": "UL0A013LS-BLK-LG",
  "Size": "LG",
  "UPC_GTN_No": ""
}
```

### Phantom variants to skip
First two records in Item_Variants response always have `Item_No: ""`. Filter them out.

## Known data quality issues

- **No real weights/dimensions** — same strategy as UPCs, captured at receiving.
- **`Unit_Cost` field is unreliable** — often inflated/stale. Use `Last_Direct_Cost`.
- **40k existing stub items in Deposco** — to be deactivated, not preserved.
- **Some variants have empty WebshopVariantCode** — fall back to flattened `{Item_No}-{Variant_Code}`.

## Build steps


Phase 2: bidirectional PO sync — single worker `src/sync.ts` deployed to Railway, working end-to-end in PILOT (see TASK.md for details). Hardening still pending.
Active-bin base set built — `build-base.mjs` → `output/payloads-base.ndjson` (4,055 lines, newPackFlag:false). **Not yet pushed to Deposco** (awaiting go + Monday newPackFlag discussion).
Lazy-load items from POs — create-if-missing in `sync.ts` push path (see TASK.md).
Incremental sync — delta queries on `Last_Date_Modified` / Deposco `updatedDate` (catches new items + the 46 base-missing).
Production hardening (idempotency keys, retries, lock, reconciliation, structured logs — see TASK.md)

---

## Phase 2: Purchase Order Sync (Bidirectional)

WSP purchase orders only. VPOD = dropship, skip for Deposco.

- **BC → Deposco:** Push Open WSP POs as expected receipts.
- **Deposco → BC:** Poll Deposco receipts, write received quantities back to BC PO lines, trigger receipt posting.

### BC v2.0 API — confirmed working

Base URL: `https://api.businesscentral.dynamics.com/v2.0/c93df08a-282d-4d69-b189-3b021ad6218e/PILOT/api/v2.0`

Company ID must be re-queried each run (it changed between sessions):
```
GET {base}/companies
→ grab id where name = 'Parsons-Kellogg'
→ PILOT returned: 0f7be801-6df3-f011-8405-0022481cc88c (do not hardcode)
```

Get Open WSP purchase orders:
```
GET {base}/companies({companyId})/purchaseOrders?$filter=status eq 'Open' and startswith(number,'WSP')&$select=id,number,status,orderDate,vendorNumber
Authorization: Bearer {token}
```

Get lines for a PO:
```
GET {base}/companies({companyId})/purchaseOrders({poId})/purchaseOrderLines
Authorization: Bearer {token}
```

PATCH a line to set receive quantity (confirmed working — response returned correct values):
```
PATCH {base}/companies({companyId})/purchaseOrderLines({lineId})
Authorization: Bearer {token}
Content-Type: application/json
If-Match: *

{ "receiveQuantity": 1, "invoiceQuantity": 0 }
```

Post the receipt (confirmed callable — hit PILOT bin config error, not an auth/routing error):
```
POST {base}/companies({companyId})/purchaseOrders({poId})/Microsoft.NAV.receiveAndInvoice
Authorization: Bearer {token}
Content-Type: application/json

{}
```

### BC v2.0 bound actions on this instance (complete list from $metadata)

| Action | Bound to |
|---|---|
| `receiveAndInvoice` | `purchaseOrder` |
| `post` | purchaseInvoice, purchaseCreditMemo, salesInvoice, salesCreditMemo, journal |
| `shipAndInvoice` | salesOrder |
| `cancel`, `cancelAndSend`, `makeCorrectiveCreditMemo`, `makeInvoice`, `makeOrder`, `postAndSend`, `send`, `restart` | various |

`releaseOrder` does NOT exist on this instance — 404 confirmed via curl.

### PO line fields

| Field | Writable | Notes |
|---|---|---|
| `receiveQuantity` | ✅ | Qty to receive in this posting run |
| `invoiceQuantity` | ✅ | **BC auto-sets this = receiveQuantity on every PATCH. Must be explicitly zeroed.** |
| `receivedQuantity` | ❌ | Cumulative posted receipts. Read-only. |
| `invoicedQuantity` | ❌ | Cumulative posted invoices. Read-only. |
| `status` (purchaseOrder) | ❌ | Read-only. Valid values confirmed: `Draft`, `In Review`, `Open` |

### Receive-only pattern (confirmed — no invoice)

```
# One PATCH per line — both fields required in same request
PATCH .../purchaseOrderLines({lineId})
If-Match: *
{ "receiveQuantity": 3, "invoiceQuantity": 0 }

# One POST per PO after all lines patched
POST .../purchaseOrders({poId})/Microsoft.NAV.receiveAndInvoice
{}
```

Setting `invoiceQuantity: 0` explicitly is required — BC auto-fills it on every `receiveQuantity` PATCH. With all lines at `invoiceQuantity=0` the action posts a receipt only (no AP invoice). Confirmed: vendor invoice error disappears when `invoiceQuantity=0`.

### Deposco PO and receipt endpoints (from HIVEv1 (2).json — not yet tested live)

```
POST /orders/purchaseOrders
GET  /receipts
GET  /receipts?orderId={deposcoOrderId}
GET  /receipts?updatedDate>{timestamp}
```

### Errors hit during development

| Error | What triggered it |
|---|---|
| `No HTTP resource was found: Microsoft.NAV.releaseOrder` | Action doesn't exist on this BC instance |
| `'Released' is not an option` on status PATCH | `status` is read-only; valid values are `Draft`, `In Review`, `Open` |
| `You need to enter Vendor Invoice No.` | `invoiceQuantity > 0` when `receiveAndInvoice` called — BC auto-set it from `receiveQuantity` |
| `The Bin does not exist. Location='PK', Code=''` | Hit on WSP32094 in PILOT after vendor invoice error was resolved. The action reached the receipt posting stage but PK location in PILOT has bin management on with no default bin. |
| `There is nothing to post` | All `receiveQuantity=0` — no-op |
| `Posting Date is not within your range of allowed posting dates` | Accounting period closed for older PILOT POs |

### Test state in PILOT (as of 2026-05-19)

- **WSP32146** — Draft PO created during testing. Needs to be deleted.
- **WSP32094 line `0a2d07b0`** (item `6000008102`) — `receiveQuantity=1, invoiceQuantity=0` set during testing. `receiveAndInvoice` failed at bin error — line was NOT posted. Still has `receiveQuantity=1`.

## Phase 3: CO + TO Sync (added 2026-06-19)

Domain layout: `src/po/sync-po.ts`, `src/co/sync-co.ts` (+ `build-co.mjs` CLI), `src/to/sync-to.ts`. Each is a standalone worker (`--once` for a single tick); lazy-item-create is duplicated across them on purpose.

**WMS-only filtering (all workers).** Only lines at a WMS-tracked warehouse are pushed; default is now **`WMS` only** (was `PK,WMS` — PK dropped). Env: `PO_WMS_LOCATIONS` / `SO_WMS_LOCATIONS` / `TO_WMS_LOCATIONS`. Fail-closed: a line whose location can't be resolved is dropped + logged.
- PO: reads `Location_Code` off ODataV4 `Purchase_Order_Line` keyed by `Line_No` (== v2.0 line `sequence`); v2.0 lines only carry a location GUID, so the OData page is required.
- CO/TO: `Location_Code` is on the OData `Sales_Order_Line` / `TransferOrderLine` directly.

**CO push (BC SO → Deposco customerOrder).** `POST /orders/customerOrders` is **NOT an upsert** — every push creates a new CO (found 9 dupes for one SO). Guard: look up by `externalOrderNumber` (the list filters on that, NOT `number` which is the Deposco CO#), skip create if one exists. Update-on-edit is a TODO (needs Deposco update-by-id). `externalLineNumber` now = BC `Line_No` (was a synthetic 1..N index) so shipments map back.

**CO ship pull (Deposco → BC), gated `SO_PULL_ENABLED=false`.** No `/shipments` endpoint exists — shipment state is inline: `GET /orders/customerOrders/{id}` → `coLines[].shippedQuantity`. Delta vs BC v2.0 `salesOrderLine.shippedQuantity` per `Line_No` → PATCH `shipQuantity` + `invoiceQuantity:0` → `Microsoft.NAV.shipAndInvoice` = **ship-only, no invoice** (exact mirror of the PO receive-only flow). `shipAndInvoice` is bound to `salesOrder`. UNVERIFIED before enabling: `External_Document_No` mandatory-field handling (analog of PO's `Vendor_Invoice_No`); nothing has shipped in PILOT yet.

**TO sync (transfer orders).** Direction is set by the WMS side (`classifyTransfer`): `from==WMS` → **ship** (WMS→anywhere), `to==WMS` → **receive** (anywhere→WMS), both→ship+receive, neither→skip. Ship reconciles BC `TransferOrderLine.Quantity_Shipped`, receive reconciles `Quantity_Received` (both + `Qty_to_Ship`/`Qty_to_Receive` exist on the OData line). Push (`TO_PUSH_ENABLED`) and pull (`TO_PULL_ENABLED`) both scaffold/default-off. **BLOCKER:** this instance exposes NO transfer post action — OData `$metadata` has no Action for transfer ship/receive and transfer orders aren't in the v2.0 API (unlike PO `receiveAndInvoice` / SO `shipAndInvoice`). Posting needs a published BC (AL) bound action; the Deposco transfer endpoint is also still unvalidated. Pull currently logs the delta plan only.
