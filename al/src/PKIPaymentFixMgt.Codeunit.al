// One-off ops tool: operate on iSolutions' "Customer Setup (iPayment)" table 70437044
// WITHOUT a dependency (RecordRef by table number, same doctrine as PK Optional Field —
// a hard dependency on a vendor app can cascade-uninstall us; see 2026-07-15).
//
// Why it exists: renaming a customer cascades into every table with a Customer No. relation,
// and iPayments' setup row makes that rename fail. iSolutions' prescribed fix (ticket,
// 2026-08-18) is: remove the 70437044 row for the customer, then rename the card. LIST gives
// a JSON backup first; DELETE removes the row(s) WITHOUT running iPayment triggers — the
// same raw removal their config-package/table-editor route performs; RENAME does the card.
codeunit 60226 "PK IPayment Fix Mgt"
{
    // Elevated so the S2S user doesn't need direct Customer modify rights for the rename.
    // (The 70437044 access itself cannot be declared here without a dependency — it rides on
    // the API user's assigned permission sets; see the runbook in scripts/ipayment-fix.mjs.)
    Permissions = tabledata Customer = RM;

    var
        IPaymentCustSetupTok: Label '70437044', Locked = true; // iPayments "Customer Setup" table id

    procedure Run(var Req: Record "PK IPayment Fix")
    begin
        case Req."Fix Action" of
            'LIST':
                ListRows(Req);
            'DELETE':
                DeleteRows(Req);
            'RENAME':
                RenameCustomer(Req);
            else
                Error('Unknown fixAction "%1" — use LIST, DELETE or RENAME.', Req."Fix Action");
        end;
    end;

    // LIST: rows of 70437044 (all, or filtered to customerNo) as JSON. Read-only reconnaissance
    // + the pre-delete backup. matchCount is the TRUE total; the JSON is capped at 10 rows.
    local procedure ListRows(var Req: Record "PK IPayment Fix")
    var
        RecRef: RecordRef;
        Rows: JsonArray;
    begin
        OpenAndFilter(RecRef, Req."Customer No.");
        Req."Match Count" := RecRef.Count();
        SerializeRows(RecRef, Rows, 10);
        Req.Result := JsonText(Rows, MaxStrLen(Req.Result));
    end;

    // DELETE: remove the row(s) for ONE explicit customer no. Serializes what it deletes into
    // Result (the backup), then deletes WITHOUT running triggers — mimicking the raw removal of
    // iSolutions' own config-package procedure, and not giving their OnDelete code a chance to
    // veto or side-effect. Refuses blank/absent/bulk matches.
    local procedure DeleteRows(var Req: Record "PK IPayment Fix")
    var
        RecRef: RecordRef;
        Rows: JsonArray;
    begin
        if Req."Customer No." = '' then
            Error('DELETE requires customerNo.');
        OpenAndFilter(RecRef, Req."Customer No.");
        Req."Match Count" := RecRef.Count();
        if Req."Match Count" = 0 then
            Error('No iPayment Customer Setup rows for customer %1 — nothing to delete.', Req."Customer No.");
        if Req."Match Count" > 5 then
            Error('%1 rows match customer %2 — refusing a bulk delete from this tool.', Req."Match Count", Req."Customer No.");
        SerializeRows(RecRef, Rows, 5);
        Req.Result := JsonText(Rows, MaxStrLen(Req.Result));
        RecRef.DeleteAll(false);
    end;

    // RENAME: the standard Customer.Rename cascade (every related table follows). Guarded so a
    // typo cannot merge two customers: the target number must be vacant.
    local procedure RenameCustomer(var Req: Record "PK IPayment Fix")
    var
        Cust: Record Customer;
        Clash: Record Customer;
    begin
        if (Req."Customer No." = '') or (Req."New No." = '') then
            Error('RENAME requires customerNo and newNo.');
        if Clash.Get(Req."New No.") then
            Error('Customer %1 already exists ("%2") — refusing to rename onto it.', Req."New No.", Clash.Name);
        Cust.Get(Req."Customer No.");
        Cust.Rename(Req."New No.");
        Req."Match Count" := 1;
        Req.Result := CopyStr(StrSubstNo('renamed customer %1 -> %2 ("%3")', Req."Customer No.", Req."New No.", Cust.Name), 1, MaxStrLen(Req.Result));
    end;

    local procedure OpenAndFilter(var RecRef: RecordRef; CustomerNo: Code[20])
    var
        TableId: Integer;
    begin
        Evaluate(TableId, IPaymentCustSetupTok);
        RecRef.Open(TableId);
        if CustomerNo <> '' then
            CustNoField(RecRef).SetRange(CustomerNo);
    end;

    // The customer-no field is the FIRST PRIMARY-KEY FIELD, verified at runtime to carry a
    // TableRelation to Customer (FieldRef.Relation). iPayCustomerSetup names it plain "No"
    // (caption "No.") per the vendor symbols, so a name match would find nothing; the
    // PK+relation shape is what actually makes it "the customer key" — and it's what the
    // platform's rename cascade keys on, which is the very collision this tool exists to clear.
    local procedure CustNoField(var RecRef: RecordRef): FieldRef
    var
        KRef: KeyRef;
        FldRef: FieldRef;
    begin
        KRef := RecRef.KeyIndex(1); // primary key
        FldRef := KRef.FieldIndex(1);
        if FldRef.Relation() <> Database::Customer then
            Error('Table %1 (%2): PK field "%3" does not relate to Customer — refusing to filter on it.',
              RecRef.Number, RecRef.Name, FldRef.Name);
        exit(FldRef);
    end;

    local procedure SerializeRows(var RecRef: RecordRef; var Rows: JsonArray; MaxRows: Integer)
    begin
        if RecRef.FindSet() then
            repeat
                Rows.Add(RowAsJson(RecRef));
            until (Rows.Count() >= MaxRows) or (RecRef.Next() = 0);
    end;

    local procedure RowAsJson(var RecRef: RecordRef): JsonObject
    var
        FldRef: FieldRef;
        Row: JsonObject;
        i: Integer;
    begin
        for i := 1 to RecRef.FieldCount() do begin
            FldRef := RecRef.FieldIndex(i);
            // Normal stored fields only: FlowFields need CalcFields, and Blob/Media values
            // (stored card artifacts) aren't Format()-able — the backup wants keys + settings.
            if FldRef.Class = FieldClass::Normal then
                if not (FldRef.Type in [FieldType::Blob, FieldType::Media, FieldType::MediaSet]) then
                    Row.Add(FldRef.Name, Format(FldRef.Value));
        end;
        exit(Row);
    end;

    local procedure JsonText(var Rows: JsonArray; MaxLen: Integer): Text
    var
        Txt: Text;
    begin
        Rows.WriteTo(Txt);
        exit(CopyStr(Txt, 1, MaxLen));
    end;
}
