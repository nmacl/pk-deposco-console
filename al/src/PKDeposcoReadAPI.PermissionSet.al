permissionset 60200 "PK Deposco Read API"
{
    Assignable = true;
    Caption = 'PK Deposco Read API';
    // Read-only: the API caller (Entra app) only needs to read the pages and their
    // source tables. No posting, no writes.
    Permissions =
        page "PK Transfer Order Line API" = X,
        page "PK Purchase Order Line API" = X,
        page "PK Sales Order Line API" = X,
        page "PK Inv Adjustment API" = X,
        page "PK Item Ledger Entry API" = X,
        page "PK Item Variant API" = X,
        page "PK Transfer Order Header API" = X,
        page "PK Posted Sales Shipment API" = X,
        page "PK Sales Shipment Read API" = X,
        codeunit "PK Inv Adjustment Mgt" = X,
        codeunit "PK Ship Tracking Mgt" = X,
        codeunit "PK Optional Field" = X,
        tabledata "Transfer Line" = R,
        tabledata "Purchase Line" = R,
        tabledata "Sales Line" = R,
        // Inventory-adjustment WRITE path: our buffer/log table + the item journal it posts through.
        tabledata "PK Inv Adjustment" = RIMD,
        tabledata "Item Journal Template" = RIM,
        tabledata "Item Journal Batch" = RIM,
        tabledata "Item Journal Line" = RIMD,
        tabledata "Item Ledger Entry" = R,
        tabledata "Item" = R,
        tabledata "Item Variant" = R,
        tabledata "Location" = R,
        tabledata "Transfer Header" = R,
        // Tracking write-back: buffer/audit table + annotate an already-posted sales
        // shipment (no insert/delete). The elevated Modify runs in "PK Ship Tracking Mgt".
        tabledata "PK Ship Tracking" = RIMD,
        tabledata "Sales Shipment Header" = RM;
}
