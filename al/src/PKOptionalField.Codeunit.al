// Reads an OPTIONAL field — one owned by another extension we deliberately do NOT take a
// dependency on — by field number at runtime via RecordRef. Returns '' when the field isn't
// present. This is how the read pages expose WebshopVariantCode (owned by UPG's PK_BC18_TAB:
// Purchase Line 50008, Sales Line 50027, Transfer Line 50201, Item Variant 50001) WITHOUT
// declaring a dependency on that extension. Consequence: if PK_BC18_TAB is absent or being
// updated, that column degrades to blank instead of cascade-uninstalling us or blocking their
// upload (which is exactly what a hard dependency did on 2026-07-15).
codeunit 60221 "PK Optional Field"
{
    procedure AsCode(RecRef: RecordRef; FieldNo: Integer): Code[50]
    var
        FldRef: FieldRef;
    begin
        if not RecRef.FieldExist(FieldNo) then
            exit('');
        FldRef := RecRef.Field(FieldNo);
        if Format(FldRef.Value) = '' then
            exit('');
        exit(CopyStr(Format(FldRef.Value), 1, 50));
    end;

    /// Write counterpart of AsCode — sets an OPTIONAL field (one owned by another extension) by
    /// field number, truncating to the target's declared length. Returns false and changes
    /// nothing when the field isn't present, so a missing/updating vendor extension degrades to
    /// a no-op instead of an error. Caller owns the RecRef.Modify().
    ///
    /// ExpectedName is REQUIRED and is the safety interlock. Field numbers are only meaningful
    /// within the app that owns them, and the same logical field can sit at different numbers in
    /// different builds — PK_BC18_TAB is published by UPG on PILOT (27.5.0.52) but by Redefine on
    /// Production (1.0.0.58). Writing a number blind could therefore hit an unrelated field in
    /// another environment. We only write when the field's actual name matches.
    procedure TrySetText(var RecRef: RecordRef; FieldNo: Integer; ExpectedName: Text; NewValue: Text): Boolean
    var
        FldRef: FieldRef;
    begin
        if not RecRef.FieldExist(FieldNo) then
            exit(false);
        FldRef := RecRef.Field(FieldNo);
        if not (FldRef.Type in [FieldType::Text, FieldType::Code]) then
            exit(false);
        // Name interlock — wrong app / renumbered field => no write, no error.
        if UpperCase(DelChr(FldRef.Name, '<>', ' ')) <> UpperCase(DelChr(ExpectedName, '<>', ' ')) then
            exit(false);
        FldRef.Value := CopyStr(NewValue, 1, FldRef.Length);
        exit(true);
    end;
}
