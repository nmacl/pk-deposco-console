// Read-only API page: transfer-order lines, flattened, in one GET.
// Publishes under the SAME api/bmi/pk/v1.0 namespace as Blue Moon's bmiTransferOrder
// (BC merges API pages across extensions), so reads and posts share one surface.
// webshopVariantCode is field 50201 on Transfer Line, owned by PK_BC18_TAB (UPG) — read at
// runtime via RecordRef (no dependency on that extension). See PKOptionalField.
page 60200 "PK Transfer Order Line API"
{
    PageType = API;
    Caption = 'PK Transfer Order Line';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiTransferOrderLine';
    EntitySetName = 'bmiTransferOrderLines';
    SourceTable = "Transfer Line";
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
                field(documentNo; Rec."Document No.") { }
                field(lineNo; Rec."Line No.") { }
                field(itemNo; Rec."Item No.") { }
                field(variantCode; Rec."Variant Code") { }
                field(webshopVariantCode; WebshopVarCode) { }
                field(description; Rec.Description) { }
                field(quantity; Rec.Quantity) { }
                field(qtyToShip; Rec."Qty. to Ship") { }
                field(quantityShipped; Rec."Quantity Shipped") { }
                field(qtyToReceive; Rec."Qty. to Receive") { }
                field(quantityReceived; Rec."Quantity Received") { }
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
        WebshopVarCode := OptField.AsCode(RecRef, 50201);
    end;
}
