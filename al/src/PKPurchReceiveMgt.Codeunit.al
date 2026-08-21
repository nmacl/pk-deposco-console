// Receive-only posting of a purchase order — the purchase-side sibling of "PK Sales Ship Mgt"
// (ship-only) and "PK Sales Return Rcpt Mgt" (return receive-only). Purch.-Post with
// Invoice=false never validates "Vendor Invoice No.", which is the whole point: the standard
// API's receiveAndInvoice action forced the pull worker to park a fake RCPT-… ref in that
// field, and the fake ref leaked into real AP invoices. The ref now goes to the dedicated
// "PK Deposco Receipt Ref" instead (order header → TransferFields → posted receipt header).
codeunit 60227 "PK Purch Receive Mgt"
{
    // Elevated writes so the limited S2S API user needs no direct rights on the documents;
    // the posting itself (receipt lines, item ledger) runs under the caller like the old
    // receiveAndInvoice path did.
    Permissions = tabledata "PK Purch Receipt" = RIMD,
                  tabledata "Purchase Header" = RM,
                  tabledata "Purchase Line" = RM,
                  tabledata "Purch. Rcpt. Header" = R;

    procedure Post(var Req: Record "PK Purch Receipt")
    var
        PurchHeader: Record "Purchase Header";
        PurchLine: Record "Purchase Line";
        PurchPost: Codeunit "Purch.-Post";
        QtyByLineNo: Dictionary of [Integer, Decimal];
        Matched: Integer;
    begin
        Req.TestField("Order No.");
        Req.TestField("Deposco Receipt Ref");
        Req.TestField(Lines);

        // Idempotent on the ref: a worker retry after a timeout/socket error must not
        // double-receive. The stamped posted receipt IS the proof of the first attempt.
        if FindPostedByRef(Req) then begin
            Req."Already Posted" := true;
            exit;
        end;

        ParseLines(Req.Lines, QtyByLineNo);

        PurchHeader.Get(PurchHeader."Document Type"::Order, Req."Order No.");
        PurchHeader."PK Deposco Receipt Ref" := Req."Deposco Receipt Ref";
        PurchHeader.Modify();

        PurchLine.SetRange("Document Type", PurchLine."Document Type"::Order);
        PurchLine.SetRange("Document No.", Req."Order No.");
        if PurchLine.FindSet(true) then
            repeat
                if PurchLine.Type <> PurchLine.Type::" " then begin
                    if QtyByLineNo.ContainsKey(PurchLine."Line No.") then begin
                        PurchLine.Validate("Qty. to Receive", QtyByLineNo.Get(PurchLine."Line No."));
                        Matched += 1;
                    end else
                        // Lines not in this pull must be ZEROED explicitly — BC defaults
                        // "Qty. to Receive" to the full outstanding quantity, which would
                        // silently receive the rest of the order as a side effect.
                        PurchLine.Validate("Qty. to Receive", 0);
                    PurchLine.Validate("Qty. to Invoice", 0);
                    PurchLine.Modify(true);
                end;
            until PurchLine.Next() = 0;

        if Matched <> QtyByLineNo.Count() then
            Error('%1 of %2 requested line(s) do not exist on purchase order %3.',
              QtyByLineNo.Count() - Matched, QtyByLineNo.Count(), Req."Order No.");
        if Matched = 0 then
            Error('No lines to receive on purchase order %1.', Req."Order No.");

        // Receive-only. Purch.-Post releases an Open order itself; errors propagate to the
        // API caller as the POST's failure message.
        PurchHeader.Receive := true;
        PurchHeader.Invoice := false;
        PurchPost.Run(PurchHeader);

        FindPostedByRef(Req);
        Req."Lines Received" := Matched;
    end;

    local procedure FindPostedByRef(var Req: Record "PK Purch Receipt"): Boolean
    var
        PurchRcptHeader: Record "Purch. Rcpt. Header";
    begin
        PurchRcptHeader.SetRange("Order No.", Req."Order No.");
        PurchRcptHeader.SetRange("PK Deposco Receipt Ref", Req."Deposco Receipt Ref");
        if not PurchRcptHeader.FindLast() then
            exit(false);
        Req."Posted Receipt No." := PurchRcptHeader."No.";
        exit(true);
    end;

    local procedure ParseLines(LinesText: Text; var QtyByLineNo: Dictionary of [Integer, Decimal])
    var
        Pair: Text;
        Parts: List of [Text];
        LineNo: Integer;
        Qty: Decimal;
    begin
        foreach Pair in LinesText.Split(',') do begin
            Parts := Pair.Split(':');
            if Parts.Count() <> 2 then
                Error('Bad line spec "%1" — expected "lineNo:qty".', Pair);
            Evaluate(LineNo, Parts.Get(1));
            Evaluate(Qty, Parts.Get(2));
            if Qty <= 0 then
                Error('Quantity must be positive in "%1".', Pair);
            QtyByLineNo.Add(LineNo, Qty);
        end;
    end;
}
