// Read-only API page: item variants with their WebshopVariantCode (PK_BC18_TAB field 50001 on
// the Item Variant table), read at runtime via RecordRef — NO dependency on that extension.
// The inventory-adjustment PULL maps Deposco's item number (== WebshopVariantCode) back to a
// BC Item No + Variant Code through this, instead of the standard ODataV4 "Item_Variants"
// query (which stops exposing the field when PK_BC18_TAB is absent). Blank if it's not
// installed. See PKOptionalField.
page 60205 "PK Item Variant API"
{
    PageType = API;
    Caption = 'PK Item Variant';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiItemVariant';
    EntitySetName = 'bmiItemVariants';
    SourceTable = "Item Variant";
    ODataKeyFields = SystemId;
    Editable = false;
    InsertAllowed = false;
    ModifyAllowed = false;
    DeleteAllowed = false;

    layout
    {
        area(Content)
        {
            repeater(Group)
            {
                field(systemId; Rec.SystemId) { }
                field(itemNo; Rec."Item No.") { }
                field(code; Rec.Code) { }
                field(webshopVariantCode; WebshopVarCode) { }
            }
        }
    }

    var
        WebshopVarCode: Code[50];

    trigger OnAfterGetRecord()
    var
        OptField: Codeunit "PK Optional Field";
        RecRef: RecordRef;
    begin
        RecRef.GetTable(Rec);
        WebshopVarCode := OptField.AsCode(RecRef, 50001);
    end;
}
