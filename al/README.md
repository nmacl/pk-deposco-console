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
| `PKOptionalField.Codeunit` (60221) | Codeunit | `AsCode(RecRef, FieldNo)` — read another extension's field by number, no dependency. |
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
