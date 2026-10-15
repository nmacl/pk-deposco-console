// Posts a purchase RETURN ORDER ship-only (Ship := true, Invoice := false, Receive := false) via
// the standard Purch.-Post codeunit — the return-to-vendor twin of "PK Sales Ship Mgt". Deposco
// picks and ships the goods back to the vendor; this records the return shipment in BC. The
// credit memo stays a finance step.
//
// Elevated so the limited S2S API user needs no direct rights on what posting touches. Stockkeeping
// Unit for the same reason as the sales side (PK_BC_customization auto-creates SKUs on item ledger
// posting); Reservation Entry because return shipments consume reservations on the lines.
codeunit 60231 "PK Purch Return Ship Mgt"
{
    Permissions = tabledata "Purchase Header" = RIM,
                  tabledata "Purchase Line" = RIM,
                  tabledata "Return Shipment Header" = RIM,
                  tabledata "Return Shipment Line" = RIM,
                  tabledata "Stockkeeping Unit" = RIM,
                  tabledata "Reservation Entry" = RIMD;

    /// Posts PurchHeader (a Return Order) as a shipment only. Whatever is staged in
    /// "Return Qty. to Ship" on each line ships — the middleware stages that via the
    /// bmiPurchaseReturnLines PATCH first. Returns the posted Return Shipment No.
    procedure PostShipOnly(var PurchHeader: Record "Purchase Header"): Code[20]
    var
        PurchPost: Codeunit "Purch.-Post";
        ReturnShptHeader: Record "Return Shipment Header";
        LastShipmentNo: Code[20];
    begin
        PurchHeader.TestField("Document Type", PurchHeader."Document Type"::"Return Order");

        if not HasQtyToShip(PurchHeader) then
            Error('Purchase return order %1 has no line with a Return Qty. to Ship — nothing to post.', PurchHeader."No.");

        PurchHeader.Ship := true;
        PurchHeader.Invoice := false;
        PurchHeader.Receive := false;
        PurchPost.Run(PurchHeader);

        ReturnShptHeader.SetCurrentKey("Return Order No.");
        ReturnShptHeader.SetRange("Return Order No.", PurchHeader."No.");
        if ReturnShptHeader.FindLast() then
            LastShipmentNo := ReturnShptHeader."No.";
        exit(LastShipmentNo);
    end;

    local procedure HasQtyToShip(var PurchHeader: Record "Purchase Header"): Boolean
    var
        PurchLine: Record "Purchase Line";
    begin
        PurchLine.SetRange("Document Type", PurchHeader."Document Type");
        PurchLine.SetRange("Document No.", PurchHeader."No.");
        PurchLine.SetFilter("Return Qty. to Ship", '<>%1', 0);
        exit(not PurchLine.IsEmpty());
    end;
}
