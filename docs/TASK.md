# Task: BC ↔ Deposco Middleware — Phase 1 Complete, Phase 2 Working in PILOT

Phase 1 (item sync) is done. Phase 2 (bidirectional PO sync) is deployed to Railway as a polling worker and confirmed working end-to-end in PILOT. Hardening still pending.

## Phase 1 — Item Sync ✅ COMPLETE (initial full load)

426,868 item payloads generated from BC and uploaded to Deposco via async bulk import API.
UPCs included at item level (`upcs.data[].value`). Audit log at `output/bulk-audit.csv`.

Scripts:
- `npm run refresh-items` — fetch BC item cards (fresh) + cached variants → regenerate `output/payloads.ndjson`
- `npm run bulk-import` — upload payloads to Deposco in batches (BATCH_SIZE=5000)

### Master-data strategy change (2026-06-09, PK ops) — active-bin base set

Steady state is **NOT** the full 427k catalog. Deposco only needs items we can transact
against: (1) items we hold stock for, (2) inbound PO items (lazy-loaded). See
PROJECT_CONTEXT.md → "Master-data strategy" for the full writeup. Summary:

- Base set = `Bin_Contents_Excel` @ `Location_Code='PK'`, `ItemSubType in ('Blank','FG')`
  (filter ItemSubType **client-side** — server-side `$filter` on it socket-hangs-up).
  Bin row already carries `WebshopVariantCode` = Deposco `number`.
- **4,101** distinct items (Decorated excluded).
- Build: `node build-base.mjs` — **live from BC, no cache** (batched variant + card
  lookups), bypasses transform exclusion filters → `output/payloads-base.ndjson`
  (4,101 lines, newPackFlag:false). All 4,101 resolve.
- Pushed 2026-06-09: **4,093 of 4,101 in Deposco; 8 rejected for duplicate UPC**
  (same UPC already on another item — BC data issue, deferred; see
  `output/base-audit-2-failures.csv`).
- ⚠ **`newPackFlag` changed `true → false`** on master upload — `true` forced Deposco to
  capture weight/dims at first receipt, which ops doesn't want. Fixed in
  `src/phase1/transform.ts`. (Discuss further Monday.)
- **Importer reporting fixed** — `bulk-import.ts` now trusts per-entity successes/
  failures (re-checks after Deposco flips Success→Partially Failed on UPC validation)
  and writes `<audit>-failures.csv`. Previously it logged "Success" while hiding failures.
- **Cleanup**: deleted the full-catalog machinery (`payloads.ndjson`, `payloads-all.ndjson`,
  `payloads.json`, `raw/` variant+card cache — ~1.2GB → 6MB). Base build no longer needs them.

**Still open:** 8 duplicate-UPC items (resolve the BC dup or drop the UPC on the loser).

---

## Phase 2 — Purchase Order Sync (WORKING in PILOT)

Bidirectional. WSP purchase orders only (VPOD = dropship, skip for Deposco). All sync logic lives in a single long-running worker `src/sync.ts`, deployed to Railway. The one-shot scripts in `src/phase2/` (push-po, receive-po, reset-po) are still useful for manual ops/debugging but the production sync is the worker.

### Sync worker (`src/sync.ts`)

Single self-contained file. Long-running process. Every `SYNC_INTERVAL_MS` (default 60s):

1. `listOpenWspPosAbove(threshold)` — `GET /purchaseOrders?$filter=startswith(number,'WSP') and number gt '<PO_THRESHOLD>'` (default threshold `WSP32153`). No status filter — BC v2.0 only exposes Draft/In Review/Open and all three work.
2. For each PO, sequentially:
   - **Push (BC → Deposco):** lookup Deposco PO by number → if missing send create payload with `orderStatus: 'New'`; if exists send update payload without `orderStatus` (Deposco rejects downgrades). `orderSource: 'BusinessCentralOnline'` on both. Soft-skip on 400 `cannot be updated while in the status of` (Partial Receipt is the locked status). Re-pushing the same PO does NOT create a duplicate in Deposco — `POST /orders/purchaseOrders` upserts on `number`.
   - **Pull (Deposco → BC):** lookup Deposco PO ID → `GET /receipts?orderId={id}` paginated via `links[].rel='next'` until `complete: true` → aggregate `receivedPackQuantity` by `orderLine.businessKey.lineNumber` (suffix matches BC `line.sequence`) → delta = `deposcoCumulative − bc.receivedQuantity` per line → post receive-only via existing `Vendor_Invoice_No` + per-line PATCH (receiveQuantity → invoiceQuantity=0) + `Microsoft.NAV.receiveAndInvoice`. Verifies BC state after post and logs `received=X invoiced=Y` per line.

Errors from one PO don't kill the tick — caught per-PO, logged, continue.

Run with `npm run sync` (or `npm start` on Railway — both point at `node dist/sync.js`).

Env: `SYNC_INTERVAL_MS`, `PO_THRESHOLD`, all `BC_*` and `DEPOSCO_*` from `.env`.

### Direction 1: BC → Deposco (push expected receipts)

### Direction 1: BC → Deposco (push expected receipts) — IMPLEMENTED in sync.ts

Read WSP POs from BC, create/update them as purchase orders in Deposco so the warehouse knows what's coming.

**Deposco PO API:** `POST /orders/purchaseOrders`

```json
{
  "businessUnit": { "businessKey": { "code": "HIVE" } },
  "number": "WSP24015",
  "orderDate": "2024-09-23",
  "plannedArrivalDate": "...",
  "placedDate": "...",
  "shipToFacility": { "businessKey": { "number": "HIVE" } },
  "orderStatus": "New",
  "orderLines": {
    "data": [
      {
        "lineNumber": "WSP24015-1",
        "item": { "businessKey": { "number": "NF0A3LH2-BLKXL", "businessUnit.code": "HIVE" } },
        "pack": { "businessKey": { "item.number": "NF0A3LH2-BLKXL", "quantity": 1, "item.businessUnit.code": "HIVE" } },
        "orderPackQuantity": 10,
        "unitCost": 15.00
      }
    ]
  }
}
```

BC source: `GET /api/v2.0/companies({id})/purchaseOrders?$filter=status eq 'Open' and startswith(number,'WSP')`
Lines: `GET /purchaseOrders({id})/purchaseOrderLines`
Item number for Deposco line = `WebshopVariantCode` (same as item `number` field in Phase 1)

**Resolving PO line → WebshopVariantCode (confirmed 2026-05-20):**

A single BC `lineObjectNumber` (Item_No) can have 100+ variants across colors and sizes. The line's `description2` is often empty (older POs) or just the size — both insufficient on their own. The reliable two-step lookup:

1. `GET /api/v2.0/companies({cid})/itemVariants({line.itemVariantId})` → returns `{ itemNumber, code }` (e.g. `100043985, 00031`)
2. `GET /ODataV4/Company('{name}')/Item_Variants?$filter=Item_No eq '{itemNumber}' and Code eq '{code}'` → returns `WebshopVariantCode` (e.g. `25882-STH-MD`)

The ODataV4 `Item_Variants` entity does NOT expose `SystemId` — filtering by GUID fails with `Could not find a property named 'SystemId' on type 'NAV.Item_Variants'`. Must use the v2.0 `itemVariants({guid})` lookup to translate GUID → (Item_No, Code) first.

**Script:** `src/phase2/push-po.ts` — manual one-shot, run with `npm run push-po -- <PO_NUMBER>` (e.g. `WSP32147` → Deposco PO id 1775 ✅). Production push lives in `sync.ts`.

**Push payload caveats discovered in PILOT:**
- `orderStatus: 'New'` accepted on initial create; on subsequent updates Deposco rejects with `"Order status updates are not accepted for order at this API Endpoint"` if you try to change status via this endpoint. Strategy: only send `orderStatus` when creating, omit it on updates. Deposco preserves whatever status the PO already has.
- `orderSource: 'BusinessCentralOnline'` lands in the Deposco list-view "Order Source" column (mirroring how BusinessCentralOnline-pushed sales orders are attributed).
- `currentStatus` field is silently ignored by `POST /orders/purchaseOrders`. The Deposco UI's "Current Status" column reflects *operational* state (Receiving / Partial Receipt / Received / Canceled) derived from receipt activity — not a field you write directly. New POs with no receipts show blank Current Status; this is intended Deposco behavior. Cosmetic only — doesn't affect sync.
- The dedicated status update endpoint is `POST /orders/purchaseOrders/{id}/status` (URL confirmed via OPTIONS — allows `GET,HEAD,POST`; `GET` returns `{"orderStatus":"X"}`). But every body shape attempted (`{orderStatus:"New"}`, `{status:"New"}`, `{newStatus:"X"}`, text/plain, query-string) returns HTTP 400 with empty body. Awaiting Deposco support for the actual schema. Request IDs filed: `ad011a52-a194-47cc-9c3e-98d1e6192cd9`, `7e8baa08-8101-44e8-a9c8-ff42caef9368`, `a76cb6c6-af38-4b97-b3fa-e3bcc2614c7a`.
- Once Deposco status is `Partial Receipt`, the main `POST /orders/purchaseOrders` rejects all updates with `"Purchase Order N cannot be updated while in the status of [Partial Receipt]. Updates can be made when in the following statuses: arrived, hold, draft, new, in-transit, receiving, received"`. Sync soft-skips this. Note `received` (fully received) IS updateable; only `partial receipt` is locked.

### Direction 2: Deposco → BC (post receipts back) — IMPLEMENTED in sync.ts

Poll Deposco for receipts, then update BC PO lines with quantities received via delta-based reconciliation.

**Deposco receipts API:**
- `GET /receipts?updatedDate>{lastPollTimestamp}` — poll for new/updated receipts
- `GET /receipts?orderId={deposcoOrderId}` — receipts for a specific PO

**BC receive-only flow — confirmed working (2026-05-20):**

Goal: post a Posted Purchase Receipt (inventory update) without creating a Purchase Invoice.

**Step 0** — Set a unique `Vendor_Invoice_No` on the PO header via ODataV4.

PILOT has "Vendor Invoice No. Mandatory" in Purchases & Payables Setup — the field must be non-empty or `receiveAndInvoice` rejects the post regardless of invoice quantity. Setting it does **not** force invoice creation; it just acts as a receipt reference. Use a unique value per run (e.g. `RCPT-{PO}-{timestamp}`) to avoid duplicate-number rejections.

```
GET /ODataV4/Company('{name}')/Purchase_Order?$filter=No eq '{number}'
  → capture @odata.etag

PATCH /ODataV4/Company('{name}')/Purchase_Order(Document_Type='Order',No='{number}')
If-Match: <etag>
{ "Vendor_Invoice_No": "RCPT-WSP32147-1748291234567" }
```

**Step 1A** — PATCH each line to set `receiveQuantity` (BC auto-sets `invoiceQuantity = receiveQuantity`):
```
PATCH /api/v2.0/companies({id})/purchaseOrderLines({lineId})
If-Match: *
{ "receiveQuantity": 1 }
```

**Step 1B** — Immediately zero `invoiceQuantity` in a **separate** PATCH call:
```
PATCH /api/v2.0/companies({id})/purchaseOrderLines({lineId})
If-Match: *
{ "invoiceQuantity": 0 }
```

**Why two calls?** Sending `{ "receiveQuantity": 1, "invoiceQuantity": 0 }` in a single PATCH doesn't suppress the auto-set — BC ignores the explicit 0. The second dedicated call zeros it correctly without resetting `receiveQuantity`.

**Step 2** — Post the receipt (once per PO after all lines patched):
```
POST /api/v2.0/companies({id})/purchaseOrders({poId})/Microsoft.NAV.receiveAndInvoice
{}
```

Returns `204 No Content`. With `invoiceQuantity=0` on all lines:
- `receivedQuantity` on each line increments ✅
- `invoicedQuantity` does NOT change ✅ (receive-only confirmed)

**PO status is irrelevant** — tested against Draft (WSP32149) and Open (WSP32148). Both receive successfully. No need to release a PO before posting a receipt.

**Script:** `src/phase2/receive-po.ts` — manual one-shot for a single PO, run with `npm run receive-po -- <PO_NUMBER>`. Production receive lives in `sync.ts`.

**Deposco receipt → BC line mapping:** Deposco receipts carry `orderLine.businessKey.lineNumber` = `"<PO>-<BC line.sequence>"` (e.g. `WSP32151-20000`). Split off the suffix and match to BC's `purchaseOrderLines.sequence` directly. No WebshopVariantCode lookup needed on the pull side.

**Idempotency:** the delta logic is self-healing. Re-running on a fully-synced PO is a no-op (`BC ahead, SKIP` printed per line). The script DOES NOT post deltas that would lower BC's `receivedQuantity` — a Deposco receipt void would silently leave BC over-received (known gap; needs reconciliation alert).

**Pagination:** `/receipts` returns up to 50 per page. Sync follows `links[].rel='next'` and stops on `complete: true` (with a 200-page safety cap).

**ODataV4 Purchase_Order key:** compound — `(Document_Type='Order',No='{number}')`. The v2.0 API does **not** expose `vendorInvoiceNumber`; must use ODataV4 `Vendor_Invoice_No` field.

### Known errors hit during development

| Error | Cause | Fix |
|---|---|---|
| `No HTTP resource was found: Microsoft.NAV.releaseOrder` | Action doesn't exist on this BC instance | Not needed — only use `receiveAndInvoice` |
| `'Released' is not an option` on status PATCH | Valid statuses are Draft, In Review, Open | Status field is read-only anyway |
| `You need to enter Vendor Invoice No.` | PILOT requires `Vendor_Invoice_No` on PO header even for receive-only | Set via ODataV4 before calling receiveAndInvoice |
| `You can't invoice more than 0 units` | `invoiceQuantity` was reset to 0 by BC (missing Vendor Invoice No.) | Set `Vendor_Invoice_No` first |
| `The Bin does not exist. Location='PK', Code=''` | PILOT warehouse bin config — PK location has bin mgmt on but no default bin | PILOT config issue only; won't occur in production with proper warehouse setup |
| `There is nothing to post` | All lines have `receiveQuantity=0` | Expected no-op response when nothing to receive |
| `The property 'vendorInvoiceNumber' does not exist` | v2.0 purchaseOrder does not expose vendor invoice no. | Use ODataV4 `Vendor_Invoice_No` field instead |

### BC v2.0 API — confirmed working

- `GET /purchaseOrders` with `$filter=status eq 'Open' and startswith(number,'WSP')` ✅
- `GET /purchaseOrders({id})/purchaseOrderLines` ✅
- `PATCH /purchaseOrderLines({id})` with `receiveQuantity` and `invoiceQuantity` ✅
- `POST /purchaseOrders({id})/Microsoft.NAV.receiveAndInvoice` ✅ — returns 204
- `PATCH /ODataV4/Purchase_Order(Document_Type='Order',No='{no}')` with `Vendor_Invoice_No` ✅

### BC v2.0 API — does NOT exist

- `Microsoft.NAV.releaseOrder` — 404, not exposed on this instance
- Direct PATCH of `status` field — read-only
- `vendorInvoiceNumber` on purchaseOrder — field not exposed in v2.0; use ODataV4

### What's left to build / harden

Sync is functional and deployed; remaining items are hardening, not new features.

**Tier 1 — before relying on it outside dev:**
1. **Idempotency key on BC receipts.** Today `Vendor_Invoice_No = RCPT-{PO}-{Date.now()}`. Include the contributing Deposco receipt IDs (e.g. `DEP-37,38,39`) so finance can trace BC receipts back to Deposco scans and BC's duplicate-detection catches accidental double-fires.
2. **Lock file / single-instance guard.** Confirm Railway is at 1 replica (no auto-scaling), or add `output/.sync.lock` with PID so two processes can't double-receive.
3. **Retry on 429/5xx with exponential backoff.** Wrap axios calls in a retry helper (3 attempts, 2s/4s/8s) on 429/502/503/504/timeout. Currently any transient blip kills the tick.
4. **Persistent run log** (CSV or SQLite). Each post records: PO, Deposco receipt IDs, BC receipt ref, qtys, timestamp. Answers "did we sync X yesterday?" without re-querying both systems.

**PO-sync correctness gaps (logged 2026-06-09, build later):**
- **>100 lines per Deposco PO.** Deposco rejects a PO create/update with >100 order lines.
  Fix = batch: send the overflow lines as a **second request with the same header
  (`number`) but new line numbers**. Effectively chunk `orderLines.data` into ≤100-line
  POSTs against the same PO.
- **Full PO line synchronicity (declarative, "like todos").** If a line is deleted in BC it
  must be deleted in Deposco; today the worker only upserts. Known bug: **deleting and
  re-adding a line changes the line identity** (BC `sequence` / Deposco `lineNumber`),
  so the Deposco line drifts from BC. Need to reconcile the full line set each push —
  add/update/delete — so Deposco mirrors BC exactly, not just additively.
- **Lazy-load create-if-missing.** In `pushPo`, before pushing, `GET /items?number=` per
  line; if missing, build from BC (`transformToDeposcoItem`) and `POST /items` first.
  Safety net so a PO never references a missing item between base-set/incremental syncs.

**Tier 2 — operational:**
5. **Reconciliation job** (daily): scan all WSP POs, log drift between Deposco cumulative and BC `receivedQuantity`. Catches missed events, manual BC adjustments, and the silent-negative-delta gap.
6. **Structured logs** (JSON one-line) so Railway logs are grep-able and pipeable to Datadog/Logtail.
7. **Healthcheck endpoint** (if Railway wiring is added) — 200 OK that bumps a timestamp each tick, surfaces a silently-dead worker.

**Tier 3 — scale/realtime:**
8. **BC webhooks** for push trigger — `POST /api/v2.0/subscriptions` with `resource = api/v2.0/companies({id})/purchaseOrders`. Subscriptions expire ~3 days, need a renewal cron + handshake endpoint. Keeps polling as a fallback for missed events.
9. **Variant code cache** for `resolveWebshopVariantCode` (2 BC calls per line per push). Becomes important past ~30 active POs (BC rate limit ~600 req/min).

**Open / awaiting external:**
- `POST /orders/purchaseOrders/{id}/status` body schema — waiting on Deposco support response.
- WSP32094 in PILOT has `receiveQuantity=1, invoiceQuantity=0` set on item `6000008102` from earlier testing. The `receiveAndInvoice` hit a bin config error before posting. Line still in pending state. Won't auto-clear; safe to ignore (sync doesn't process POs ≤ `PO_THRESHOLD` anyway).
- Test PO WSP32146 (Draft, created during testing) — still wants deletion. Optional cleanup.

### Production state (as of 2026-05-27)

- Sync worker deployed to Railway, running every 60s
- PO_THRESHOLD = `WSP32153` (only processes `gt 'WSP32153'`, i.e. WSP32154 onward)
- WSP32154 successfully received end-to-end after switching its lines from PK location to WMS (PK has unfixed bin config; WMS works)
- WSP32155–32157 created and visible in Deposco; awaiting warehouse receipt activity
- GitHub repo set up with `.gitignore` excluding phase1/, phase2/, output/, .env, dist/ — only sync.ts + auth.ts + deposco.ts + types.ts + config files commit
- Railway start command: `node dist/sync.js` (via `npm start`)

## Phase 3 — CO + TO Sync (2026-06-19)

Workers: `src/co/sync-co.ts` (+ `build-co.mjs`), `src/to/sync-to.ts`, alongside `src/po/sync-po.ts`. All support `--once`.

**WMS-only push (all workers).** Default changed to **`WMS` only** (PK dropped). Env `PO_/SO_/TO_WMS_LOCATIONS`. Non-WMS lines dropped + logged (fail-closed).
- PO location comes from ODataV4 `Purchase_Order_Line.Location_Code` keyed by `Line_No` (v2.0 lines only expose a location GUID).

**CO push** (`POST /orders/customerOrders`): does NOT upsert → was minting duplicate COs every tick. Now looks up by `externalOrderNumber` and skips if a CO exists (TODO: update-on-edit). `externalLineNumber` = BC `Line_No` for shipment reconciliation.

**CO ship pull** — IMPLEMENTED, gated `SO_PULL_ENABLED=false`:
- No `/shipments` endpoint; read `coLines[].shippedQuantity` from `GET /orders/customerOrders/{id}`.
- Delta vs BC v2.0 `salesOrderLine.shippedQuantity` per `Line_No` → PATCH `shipQuantity` + `invoiceQuantity:0` → `Microsoft.NAV.shipAndInvoice` = ship-only (mirrors PO receive-only).
- TODO before enabling: verify `External_Document_No` mandatory handling; add tracking-number write-back (fulfillmentOrders shape unseen until a CO ships). Nothing shipped in PILOT yet.

**TO sync** — direction by WMS side (`classifyTransfer`): `from==WMS`→ship (WMS→anywhere), `to==WMS`→receive (anywhere→WMS), both→ship+receive, neither→skip. Ship→BC `Quantity_Shipped`, receive→`Quantity_Received`. Push (`TO_PUSH_ENABLED`) + pull (`TO_PULL_ENABLED`) both scaffold/off. BLOCKER: no BC transfer post action exists (no OData Action, not in v2.0 API) — needs a published AL bound action; Deposco transfer endpoint also unvalidated. Pull logs delta plan only.
