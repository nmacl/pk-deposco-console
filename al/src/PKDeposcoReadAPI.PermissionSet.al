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
        page "PK Sales Order API" = X,
        page "PK Sales Return Order API" = X,
        page "PK Sales Return Line API" = X,
        codeunit "PK Inv Adjustment Mgt" = X,
        codeunit "PK Ship Tracking Mgt" = X,
        codeunit "PK Optional Field" = X,
        codeunit "PK Sales Ship Mgt" = X,
        codeunit "PK Sales Return Rcpt Mgt" = X,
        tabledata "Transfer Line" = R,
        tabledata "Purchase Line" = R,
        // Ship-only posting stages nothing itself, but Sales-Post reads/updates both the header
        // and the lines it posts, so R alone is not enough here. The elevated writes that posting
        // needs beyond this (shipment header/line, SKU auto-create) live on "PK Sales Ship Mgt".
        tabledata "Sales Line" = RM,
        tabledata "Sales Header" = RM,
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
