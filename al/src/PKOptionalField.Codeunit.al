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
}
