# PK Deposco Read/Write API — Business Central AL extension

The BC-side half of the PK↔Deposco middleware. A **standalone** extension (no dependency on
any vendor extension) that exposes custom `api/bmi/pk/v1.0` API pages the Node workers read/write,
plus the inventory-adjustment write path (item-journal post).

- **Object range:** 60200–60249  •  **Namespace:** `bmi/pk`  •  **Version:** see [app.json](app.json)
- **Standalone:** `dependencies: []`. Other extensions' fields are read by field *number* at runtime
  (`PKOptionalField.AsCode`) so a vendor uploading/removing their app can't cascade-uninstall us.

## What's inside (`src/`)

| Object | Type | Purpose |
|--------|------|---------|
| `PKInvAdjustment.Table` (60210) | Table | Staging/log buffer for inventory adjustments. Has `InherentPermissions = RIMDX` (required — the S2S user 403s on IndirectInsert without it). |
| `PKInvAdjustmentMgt.Codeunit` (60220) | Codeunit | Posts a Positive/Negative item-journal adjustment via a dedicated template/batch; floor-at-zero; idempotency by external id; reads ILE back by document no. |
| `PKInvAdjustmentAPI.Page` (60203) | API page | `bmiInventoryAdjustments` — post-on-insert. |
| `PKItemLedgerEntryAPI.Page` (60204) | API page | `bmiItemLedgerEntries` — read ILE. |
| `PKItemVariantAPI.Page` (60205) | API page | `bmiItemVariants` — reads WebshopVariantCode (field 50001) via FieldRef. |
| `PKPurchaseOrderLineAPI.Page` / `PKSalesOrderLineAPI.Page` | API pages | PO / SO line reads (WebshopVariantCode by field no.). |
| `PKTransferOrderHeaderAPI.Page` (60206) / `PKTransferOrderLineAPI.Page` | API pages | `bmiTransferHeaders` / lines — decouples TO sync from the fragile OData feed. |
| `PKOptionalField.Codeunit` (60221) | Codeunit | `AsCode(RecRef, FieldNo)` — read another extension's field by number, no dependency. `TrySetText` is the write counterpart. |
| `PKSalesShipmentExt.TableExt` (60230) | TableExt | Deposco tracking payload on `Sales Shipment Header` (fields 60200-60211): tracking no./URL, carrier, ship via, container LPN, synced-at. |
| `PKPostedSalesShipmentPageExt.PageExt` (60231) | PageExt | Surfaces those fields in a **Deposco** group on the Posted Sales Shipment card. |
| `PKShipTracking.Table` (60211) | Table | Buffer/audit table for the tracking write-back. `InherentPermissions = RIMDX` (same reason as 60210). |
| `PKShipTrackingMgt.Codeunit` (60222) | Codeunit | Applies a buffer row onto the posted shipment. Holds `Permissions = tabledata "Sales Shipment Header" = RM` — a page modifying it directly runs under the CALLER's rights and 403s on the S2S license. Also mirrors the carrier into UPG's `PackageCarrier` (50130) and handles `clearTracking`. |
| `PKPostedSalesShipmentAPI.Page` (60207) | API page | `bmiShipmentTrackings` — POST tracking, applied-on-insert. Match by `shipmentNo` or `externalDocumentNo` (the `SHIP-{soNo}-{epoch}` ref sync-co.ts stamps before posting). |
| `PKIPaymentFix.Table` (60214) / `PKIPaymentFixAPI.Page` (60214) / `PKIPaymentFixMgt.Codeunit` (60226) | Table / API page / Codeunit | **One-off ops tool** (`bmiIPaymentFixes`, execute-on-insert): LIST/DELETE rows of iSolutions' iPayments Customer Setup table 70437044 via RecordRef (no dependency) + guarded customer RENAME. Added for the "customer S → CTDI003931" fix (Aug 2026); remove once obsolete. |
| `PKDeposcoReadAPI.PermissionSet` | PermissionSet | Grants all pages/codeunits/tabledata. |

## Build (headless, macOS)

Symbols live in `.alpackages/` (gitignored — pull them from BC once, then reuse):

```bash
# 1. one-time: download symbols from your BC environment into .alpackages/
#    (VS Code "AL: Download Symbols", or the /dev/packages endpoint)

# 2. compile with the bundled AL compiler (path tracks the installed AL extension version)
ALC=~/.vscode/extensions/ms-dynamics-smb.al-*/bin/darwin/alc
$ALC /project:"$(pwd)" /packagecachepath:"$(pwd)/.alpackages" /out:PK_Deposco_ReadAPI.app
```

Produces `PK_Deposco_ReadAPI.app` (committed here as the last-known-good artifact).

## Publish to BC

Uses the BC Automation API. Needs the same `.env` the console uses (BC_TENANT_ID, BC_ENVIRONMENT,
BC_CLIENT_ID, BC_CLIENT_SECRET) and a built `../dist/auth.js` (run `npm run build` in the console first):

```bash
cd ..            # console root
npm run build    # produces dist/auth.js that publish.mjs imports
node al/publish.mjs            # publishes al/PK_Deposco_ReadAPI.app
node al/publish.mjs some.app   # or an explicit .app path
```

## ⚠️ Every prod/PILOT refresh wipes this extension

A BC environment refresh removes non-AppSource extensions. After any refresh, **rebuild + republish**
(and re-check the DEPOSCO/PKDEP item-journal template/batch + the location's Adjustment Bin Code exist).
This committed `.app` + source is the backup that makes that a 2-minute recovery instead of a rewrite.
