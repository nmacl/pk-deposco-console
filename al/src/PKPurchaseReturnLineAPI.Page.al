// Purchase RETURN ORDER lines, flattened (webshopVariantCode via field 50008, same as
// bmiPurchaseOrderLines). See PKPurchaseReturnOrderAPI.Page.al.
page 60224 "PK Purchase Return Line API"
{
    PageType = API;
    Caption = 'PK Purchase Return Line';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiPurchaseReturnLine';
    EntitySetName = 'bmiPurchaseReturnLines';
    SourceTable = "Purchase Line";
    SourceTableView = where("Document Type" = const("Return Order"));
    ODataKeyFields = SystemId;
    InsertAllowed = false;
    ModifyAllowed = true;   // exactly one writable field: returnQtyToShip (staging before postShipment)
    DeleteAllowed = false;

    layout
    {
        area(Content)
        {
            repeater(Group)
            {
                field(systemId; Rec.SystemId) { Editable = false; }
                field(documentNo; Rec."Document No.") { Editable = false; }
                field(lineNo; Rec."Line No.") { Editable = false; }
                field(type; Rec.Type) { Editable = false; }
                field(itemNo; Rec."No.") { Editable = false; }
                field(variantCode; Rec."Variant Code") { Editable = false; }
                field(webshopVariantCode; WebshopVarCode) { Editable = false; }
                field(description; Rec.Description) { Editable = false; }
                field(locationCode; Rec."Location Code") { Editable = false; }
                field(binCode; Rec."Bin Code") { Editable = false; }
                field(quantity; Rec.Quantity) { Editable = false; }
                field(outstandingQuantity; Rec."Outstanding Quantity") { Editable = false; }
                field(returnQtyToShip; Rec."Return Qty. to Ship") { }
                field(returnQtyShipped; Rec."Return Qty. Shipped") { Editable = false; }
                field(directUnitCost; Rec."Direct Unit Cost") { Editable = false; }
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
        WebshopVarCode := OptField.AsCode(RecRef, 50008);
    end;
}
