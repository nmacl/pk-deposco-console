// Posts a sales RETURN ORDER receive-only (Receive := true, Invoice := false) via the standard
// Sales-Post codeunit. Exists for the same reason as "PK Sales Ship Mgt": BC's api/v2.0 exposes
// no sales-return-order entity at all, let alone a receive-only action, and the middleware must
// never invoice — the return receipt puts inventory back on hand and the credit memo stays a
// finance decision in BC.
//
// Permissions: elevated so the limited S2S API user does not need direct rights on what posting
// touches — mirrors "PK Sales Ship Mgt". Stockkeeping Unit is here for the same reason as there:
// PK_BC_customization subscribes to Item Jnl.-Post Line.OnBeforeInsertItemLedgEntry and
// auto-creates an SKU for any posted item/variant/location combination that lacks one, and a
// return receipt posts item ledger entries.
codeunit 60224 "PK Sales Return Rcpt Mgt"
{
    Permissions = tabledata "Sales Header" = RIM,
                  tabledata "Sales Line" = RIM,
                  tabledata "Return Receipt Header" = RIM,
                  tabledata "Return Receipt Line" = RIM,
                  tabledata "Stockkeeping Unit" = RIM;

    /// <summary>
    /// Posts SalesHeader (a Return Order) as a receipt only. Whatever is staged in
    /// "Return Qty. to Receive" on each line is what gets received — the caller (middleware)
    /// stages those first via the bmiSalesReturnLines PATCH. Nothing is invoiced.
    /// Returns the posted Return Receipt No.; throws on any posting error so the middleware
    /// sees BC's own message.
    /// </summary>
    procedure PostReceiveOnly(var SalesHeader: Record "Sales Header"): Code[20]
    var
        SalesPost: Codeunit "Sales-Post";
        ReturnRcptHeader: Record "Return Receipt Header";
        LastReceiptNo: Code[20];
    begin
        SalesHeader.TestField("Document Type", SalesHeader."Document Type"::"Return Order");

        if not HasQtyToReceive(SalesHeader) then
            Error('Return order %1 has no line with a Return Qty. to Receive — nothing to post.', SalesHeader."No.");

        SalesHeader.Receive := true;
        SalesHeader.Invoice := false;   // <- the whole point of this codeunit
        SalesHeader.Ship := false;
        SalesPost.Run(SalesHeader);

        // Return the posted receipt number so the middleware can log the exact document.
        ReturnRcptHeader.SetRange("Return Order No.", SalesHeader."No.");
        if ReturnRcptHeader.FindLast() then
            LastReceiptNo := ReturnRcptHeader."No.";
        exit(LastReceiptNo);
    end;

    local procedure HasQtyToReceive(var SalesHeader: Record "Sales Header"): Boolean
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.SetRange("Document Type", SalesHeader."Document Type");
        SalesLine.SetRange("Document No.", SalesHeader."No.");
        SalesLine.SetFilter("Return Qty. to Receive", '<>%1', 0);
        exit(not SalesLine.IsEmpty());
    end;
}
