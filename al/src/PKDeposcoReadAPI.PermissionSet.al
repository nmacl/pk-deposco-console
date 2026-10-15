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
        // 2.18: transfer-shipment tracking (twin of the sales tracking objects) + salesperson lookup.
        page "PK Transfer Ship Tracking API" = X,
        page "PK Transfer Shipment Read API" = X,
        page "PK Salesperson API" = X,
        codeunit "PK Transfer Ship Tracking Mgt" = X,
        tabledata "PK Transfer Ship Tracking" = RIMD,
        tabledata "Transfer Shipment Header" = RM,
        tabledata "Salesperson/Purchaser" = R,
        // 2.19: production orders (read-only) + transfer carrier/derived-line fields.
        page "PK Production Order API" = X,
        page "PK Production Order Line API" = X,
        page "PK Prod. Order Component API" = X,
        tabledata "Production Order" = R,
        tabledata "Prod. Order Line" = R,
        tabledata "Prod. Order Component" = R,
        // 2.20: purchase return orders (PROD…, return to vendor), read-only for now.
        page "PK Purchase Return Order API" = X,
        page "PK Purchase Return Line API" = X,
        codeunit "PK Purch Return Ship Mgt" = X,
        tabledata "Purchase Header" = RM,
        tabledata "Return Shipment Header" = R,
        codeunit "PK Inv Adjustment Mgt" = X,
        codeunit "PK Ship Tracking Mgt" = X,
        codeunit "PK Optional Field" = X,
        codeunit "PK Sales Ship Mgt" = X,
        codeunit "PK Sales Return Rcpt Mgt" = X,
        // One-off iPayment fix surface (LIST/DELETE on iSolutions table 70437044 rides on the
        // API user's own permission sets — RecordRef, not declarable here without a dependency).
        page "PK IPayment Fix API" = X,
        codeunit "PK IPayment Fix Mgt" = X,
        tabledata "PK IPayment Fix" = RIMD,
        // Receive-only purchase posting (replaces the receiveAndInvoice + Vendor-Invoice-No.
        // workaround). Header/line writes are elevated inside "PK Purch Receive Mgt".
        page "PK Purch Receipt API" = X,
        codeunit "PK Purch Receive Mgt" = X,
        tabledata "PK Purch Receipt" = RIMD,
        tabledata "Purch. Rcpt. Header" = R,
        tabledata "Transfer Line" = R,
        // RM: the pro worker PATCHes "Return Qty. to Ship" through bmiPurchaseReturnLines.
        tabledata "Purchase Line" = RM,
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
        tabledata "Sales Shipment Header" = RM,
        // Kept from the rolled-back shipping-cost button (2.12): harmless reads, and removing
        // grants is what breaks callers. The codeunit/pageext sources are parked in al-hold/.
        tabledata "Purch. Inv. Header" = R,
        tabledata "Purch. Inv. Line" = R,
        tabledata "Purchases & Payables Setup" = R,
        tabledata "Sales & Receivables Setup" = R;
}
