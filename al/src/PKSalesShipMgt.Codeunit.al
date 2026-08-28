// Posts a sales order SHIP-ONLY (Ship := true, Invoice := false) via the standard Sales-Post
// codeunit. Exists because BC's api/v2.0 salesOrders entity exposes exactly ONE posting action —
// Microsoft.NAV.shipAndInvoice — with no ship-only counterpart, so the middleware previously had
// to talk that action out of invoicing by zeroing Qty. to Invoice on every line first.
//
// That workaround broke on any order carrying a non-item line. shipAndInvoice posts the WHOLE
// document, and BC stages every line at full Quantity on release, so a charge line the middleware
// didn't know about stayed queued to invoice. Invoicing it posted a G/L entry, and PK_BC_customization
// subscribes to Gen. Jnl.-Post Line.OnAfterInitGLEntry and INSERTs a "SalesPerson Commission" row
// when the account is the Sales Commission Balance G/L. The S2S API user cannot insert there:
//   HTTP 400 "the current permissions prevented the action.
//             (TableData 50026 SalesPerson Commission Insert: PK_BC_customization)"
// and because posting is one transaction the shipment rolled back with it — DISO211236 re-staged
// and re-failed every tick for a day. Ship-only cannot hit that path at all: a G/L Account line
// only reaches the general ledger when INVOICED, so the G/L entry is never created and the
// subscriber never reaches its INSERT.
//
// Permissions: elevated so the limited S2S API user does not need direct rights on what posting
// touches — mirrors "PK Inv Adjustment Mgt". Stockkeeping Unit is here deliberately: the same
// customization subscribes to Item Jnl.-Post Line.OnBeforeInsertItemLedgEntry and auto-creates an
// SKU (report "Create Stockkeeping Unit") for any shipped item/variant/location combination that
// lacks one — that DOES fire on a ship-only post, unlike the commission insert.
codeunit 60223 "PK Sales Ship Mgt"
{
    Permissions = tabledata "Sales Header" = RIM,
                  tabledata "Sales Line" = RIM,
                  tabledata "Sales Shipment Header" = RIM,
                  tabledata "Sales Shipment Line" = RIM,
                  tabledata "Stockkeeping Unit" = RIM,
                  tabledata "Reservation Entry" = RIMD;

    /// <summary>
    /// Posts SalesHeader as a shipment only. Whatever is staged in Qty. to Ship on each line is
    /// what ships — the caller (middleware) stages those first, exactly as it already does before
    /// shipAndInvoice. Qty. to Invoice is left ALONE: nothing is invoiced, and BC re-derives it as
    /// shipped-minus-invoiced afterwards, so freight/charge lines stay billable untouched.
    /// Throws on any posting error so the middleware sees BC's own message.
    /// </summary>
    procedure PostShipOnly(var SalesHeader: Record "Sales Header"): Code[20]
    var
        SalesPost: Codeunit "Sales-Post";
        SalesShptHeader: Record "Sales Shipment Header";
        LastShipmentNo: Code[20];
    begin
        SalesHeader.TestField("Document Type", SalesHeader."Document Type"::Order);

        if not HasQtyToShip(SalesHeader) then
            Error('Sales order %1 has no line with a Qty. to Ship — nothing to post.', SalesHeader."No.");

        SalesHeader.Ship := true;
        SalesHeader.Invoice := false;   // <- the whole point of this codeunit
        SalesHeader.Receive := false;
        SalesPost.Run(SalesHeader);

        // Return the posted shipment number so the middleware can tie tracking write-back to the
        // exact document instead of stamping a synthetic ref onto External Document No. first
        // (which overwrote the customer's PO number on every attempt).
        SalesShptHeader.SetCurrentKey("Order No.");
        SalesShptHeader.SetRange("Order No.", SalesHeader."No.");
        if SalesShptHeader.FindLast() then
            LastShipmentNo := SalesShptHeader."No.";
        exit(LastShipmentNo);
    end;

    local procedure HasQtyToShip(var SalesHeader: Record "Sales Header"): Boolean
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.SetRange("Document Type", SalesHeader."Document Type");
        SalesLine.SetRange("Document No.", SalesHeader."No.");
        SalesLine.SetFilter("Qty. to Ship", '<>%1', 0);
        exit(not SalesLine.IsEmpty());
    end;

    /// <summary>
    /// Drops the reservation entries on every open item line of SalesHeader — same effect as the
    /// "Cancel Reservation" ribbon action on the Sales Order page, called headlessly.
    ///
    /// Why: PostShipOnly fails hard when a line's Reservation Entry no longer matches reality —
    /// "insufficient quantity" / "Reserved item ... is not on inventory" when the specific supply
    /// it points at has since been consumed elsewhere, or "Location/Variant Code must equal ..."
    /// when the entry was written against the wrong location or variant. In every one of these
    /// cases Deposco has ALREADY physically shipped the order; BC's reservation is stale or wrong,
    /// not the truth. Forcing negative inventory or floor-adjusting the item doesn't fix a bad
    /// reservation — it just fixes on-hand while the mismatched entry is still there to fail again.
    /// Cancelling it lets the retry consume general on-hand instead of that one specific (and
    /// wrong) earmark. Caller decides when this is warranted by matching BC's error text — this
    /// procedure does not judge, it just drops the reservation.
    /// </summary>
    procedure CancelReservations(var SalesHeader: Record "Sales Header")
    var
        SalesLine: Record "Sales Line";
        SalesLineReserve: Codeunit "Sales Line-Reserve";
    begin
        SalesLine.SetRange("Document Type", SalesHeader."Document Type");
        SalesLine.SetRange("Document No.", SalesHeader."No.");
        SalesLine.SetRange(Type, SalesLine.Type::Item);
        SalesLine.SetFilter("Outstanding Quantity", '<>%1', 0);
        if SalesLine.FindSet() then
            repeat
                SalesLineReserve.DeleteLine(SalesLine);
            until SalesLine.Next() = 0;
    end;
}
