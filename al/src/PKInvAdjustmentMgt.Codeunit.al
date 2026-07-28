// Posts a "PK Inv Adjustment" row into a dedicated item journal (template PKDEP / batch
// DEPOSCO, auto-created on first use) as a Positive/Negative Adjmt. and returns the
// resulting Item Ledger Entry No. Mirrors the "middleware writes, BC posts" pattern used
// by the transfer postShipment/postReceipt actions — one call does line-build + post.
codeunit 60220 "PK Inv Adjustment Mgt"
{
    // Elevated writes: the S2S API user need not hold direct Insert on these — the codeunit's
    // Permissions grant it to code running here. (This is why the page delegates the audit-row
    // Insert to us rather than doing Rec.Insert itself, which runs under the caller's rights.)
    Permissions = tabledata "PK Inv Adjustment" = RIMD,
                  tabledata "Item Journal Template" = RIM,
                  tabledata "Item Journal Batch" = RIM,
                  tabledata "Item Journal Line" = RIMD;

    var
        TemplateNameTok: Label 'PKDEP', Locked = true;
        BatchNameTok: Label 'DEPOSCO', Locked = true;

    // Builds + posts one adjustment line. Throws on any posting error (caller/middleware
    // sees the message); on success stamps Posted + Item Ledger Entry No. onto Adj.
    procedure Post(var Adj: Record "PK Inv Adjustment")
    var
        ItemJnlLine: Record "Item Journal Line";
        ItemJnlPostLine: Codeunit "Item Jnl.-Post Line";
        EffectiveQty: Decimal;
        Available: Decimal;
    begin
        if Adj.Quantity = 0 then
            Error('Adjustment quantity cannot be zero (item %1).', Adj."Item No.");
        if (Adj."External Adjustment Id" <> '') and AlreadyPosted(Adj."External Adjustment Id") then
            Error('External Adjustment Id %1 has already been posted.', Adj."External Adjustment Id");

        // FLOOR AT ZERO (Deposco is the 1:1 source of truth, but BC physical on-hand can't go
        // below 0). For a decrement, clamp to what BC actually has at this location/variant so
        // it lands on 0 instead of underflowing. Any clamp/floor is a real BC↔Deposco desync,
        // recorded on "Error Message" + "Posted Quantity" for the console to surface.
        EffectiveQty := Adj.Quantity;
        Adj."Error Message" := '';
        if Adj.Quantity < 0 then begin
            Available := AvailableQty(Adj);
            if Available <= 0 then begin
                Adj.Posted := false;
                Adj."Posted Quantity" := 0;
                Adj."Item Ledger Entry No." := 0;
                Adj."Document No." := DocNoOf(Adj);
                Adj."Error Message" := StrSubstNo('FLOORED (desync): Deposco delta %1 but BC on-hand is %2 at %3 — nothing posted', Adj.Quantity, Available, Adj."Location Code");
                exit; // no journal post; the platform still inserts the audit row (Posted=false)
            end;
            if Abs(Adj.Quantity) > Available then begin
                Adj."Error Message" := StrSubstNo('CLAMPED (desync): Deposco delta %1, BC on-hand %2 — floored to 0 (short %3)', Adj.Quantity, Available, Abs(Adj.Quantity) - Available);
                EffectiveQty := -Available; // land exactly on 0
            end;
        end;

        EnsureSetup();

        ItemJnlLine.Init();
        ItemJnlLine.Validate("Journal Template Name", CopyStr(TemplateNameTok, 1, 10));
        ItemJnlLine.Validate("Journal Batch Name", CopyStr(BatchNameTok, 1, 10));
        ItemJnlLine."Line No." := NextLineNo();
        if Adj."Posting Date" = 0D then
            ItemJnlLine.Validate("Posting Date", WorkDate())
        else
            ItemJnlLine.Validate("Posting Date", Adj."Posting Date");
        if EffectiveQty > 0 then
            ItemJnlLine.Validate("Entry Type", ItemJnlLine."Entry Type"::"Positive Adjmt.")
        else
            ItemJnlLine.Validate("Entry Type", ItemJnlLine."Entry Type"::"Negative Adjmt.");
        ItemJnlLine.Validate("Item No.", Adj."Item No.");
        if Adj."Variant Code" <> '' then
            ItemJnlLine.Validate("Variant Code", Adj."Variant Code");
        if Adj."Location Code" <> '' then
            ItemJnlLine.Validate("Location Code", Adj."Location Code");
        ApplyBin(ItemJnlLine, Adj);
        ItemJnlLine.Validate(Quantity, Abs(EffectiveQty));
        ItemJnlLine."Document No." := DocNoOf(Adj);
        if Adj."Reason Code" <> '' then
            ItemJnlLine.Validate("Reason Code", Adj."Reason Code");

        ItemJnlPostLine.RunWithCheck(ItemJnlLine);

        Adj.Posted := true;
        Adj."Posted Quantity" := EffectiveQty;
        Adj."Item Ledger Entry No." := FindPostedEntryNo(ItemJnlLine);
        Adj."Document No." := ItemJnlLine."Document No.";
        // NB: we only STAGE the row here. The API page's OnInsertRecord returns true so the
        // platform performs the single insert (the table's InherentPermissions authorize it).
    end;

    // BC on-hand for an item/variant at a location (net Item Ledger Entry qty). Used to floor
    // decrements at zero. Respects the Location + Variant flowfield filters.
    local procedure AvailableQty(var Adj: Record "PK Inv Adjustment"): Decimal
    var
        Item: Record Item;
    begin
        if not Item.Get(Adj."Item No.") then
            exit(0);
        if Adj."Location Code" <> '' then
            Item.SetRange("Location Filter", Adj."Location Code");
        if Adj."Variant Code" <> '' then
            Item.SetRange("Variant Filter", Adj."Variant Code");
        Item.CalcFields(Inventory);
        exit(Item.Inventory);
    end;

    // Codeunit "Item Jnl.-Post Line" exposes no entry-no getter across versions, so read the
    // ILE back by the (unique) document no. we stamped on the line.
    local procedure FindPostedEntryNo(var ItemJnlLine: Record "Item Journal Line"): Integer
    var
        ItemLedgEntry: Record "Item Ledger Entry";
    begin
        ItemLedgEntry.SetRange("Item No.", ItemJnlLine."Item No.");
        ItemLedgEntry.SetRange("Document No.", ItemJnlLine."Document No.");
        if ItemLedgEntry.FindLast() then
            exit(ItemLedgEntry."Entry No.");
        exit(0);
    end;

    // Bin-mandatory locations (WMS/directed) reject an item-journal line with no Bin Code.
    // Use the caller's explicit Bin Code, else the location's standard Adjustment Bin Code.
    local procedure ApplyBin(var ItemJnlLine: Record "Item Journal Line"; var Adj: Record "PK Inv Adjustment")
    var
        Location: Record Location;
    begin
        if Adj."Location Code" = '' then
            exit;
        if Adj."Bin Code" <> '' then begin
            ItemJnlLine.Validate("Bin Code", Adj."Bin Code");
            exit;
        end;
        if not Location.Get(Adj."Location Code") then
            exit;
        if not Location."Bin Mandatory" then
            exit;
        if Location."Adjustment Bin Code" = '' then
            Error('Location %1 is bin-mandatory but has no Adjustment Bin Code, and no binCode was supplied.', Adj."Location Code");
        ItemJnlLine.Validate("Bin Code", Location."Adjustment Bin Code");
    end;

    local procedure AlreadyPosted(ExtId: Code[35]): Boolean
    var
        Existing: Record "PK Inv Adjustment";
    begin
        Existing.SetRange("External Adjustment Id", ExtId);
        Existing.SetRange(Posted, true);
        exit(not Existing.IsEmpty());
    end;

    local procedure DocNoOf(var Adj: Record "PK Inv Adjustment"): Code[20]
    begin
        if Adj."Document No." <> '' then
            exit(Adj."Document No.");
        if Adj."External Adjustment Id" <> '' then
            exit(CopyStr('DEP' + Adj."External Adjustment Id", 1, 20));
        exit(CopyStr(Format(Adj."Entry No."), 1, 20));
    end;

    local procedure NextLineNo(): Integer
    var
        ItemJnlLine: Record "Item Journal Line";
    begin
        ItemJnlLine.SetRange("Journal Template Name", CopyStr(TemplateNameTok, 1, 10));
        ItemJnlLine.SetRange("Journal Batch Name", CopyStr(BatchNameTok, 1, 10));
        if ItemJnlLine.FindLast() then
            exit(ItemJnlLine."Line No." + 10000);
        exit(10000);
    end;

    local procedure EnsureSetup()
    var
        ItemJnlTemplate: Record "Item Journal Template";
        ItemJnlBatch: Record "Item Journal Batch";
    begin
        if not ItemJnlTemplate.Get(CopyStr(TemplateNameTok, 1, 10)) then begin
            ItemJnlTemplate.Init();
            ItemJnlTemplate.Validate(Name, CopyStr(TemplateNameTok, 1, 10));
            ItemJnlTemplate.Validate(Type, ItemJnlTemplate.Type::Item);
            ItemJnlTemplate.Description := 'Deposco Adjustments';
            ItemJnlTemplate.Insert(true);
        end;
        if not ItemJnlBatch.Get(CopyStr(TemplateNameTok, 1, 10), CopyStr(BatchNameTok, 1, 10)) then begin
            ItemJnlBatch.Init();
            ItemJnlBatch."Journal Template Name" := CopyStr(TemplateNameTok, 1, 10);
            ItemJnlBatch.Validate(Name, CopyStr(BatchNameTok, 1, 10));
            ItemJnlBatch.Description := 'Deposco Adjustments';
            ItemJnlBatch.Insert(true);
        end;
    end;
}
