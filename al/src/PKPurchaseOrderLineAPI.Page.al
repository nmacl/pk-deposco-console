// Read-only API page: purchase-order lines, flattened, in one GET.
// Returns Location Code + WebshopVariantCode (field 50008, owned by PK_BC18_TAB) directly,
// so the Node middleware no longer needs resolveWebshopVariantCode (2 calls/line) or
// getLineLocations. SourceTableView pins it to purchase ORDER lines only.
page 60201 "PK Purchase Order Line API"
{
    PageType = API;
    Caption = 'PK Purchase Order Line';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiPurchaseOrderLine';
    EntitySetName = 'bmiPurchaseOrderLines';
    SourceTable = "Purchase Line";
    SourceTableView = where("Document Type" = const(Order));
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
                field(type; Rec.Type) { }
                field(itemNo; Rec."No.") { }
                field(variantCode; Rec."Variant Code") { }
                field(webshopVariantCode; WebshopVarCode) { }
                field(locationCode; Rec."Location Code") { }
                field(description; Rec.Description) { }
                field(quantity; Rec.Quantity) { }
                field(outstandingQuantity; Rec."Outstanding Quantity") { }
                field(quantityReceived; Rec."Quantity Received") { }
                field(qtyToReceive; Rec."Qty. to Receive") { }
                field(directUnitCost; Rec."Direct Unit Cost") { }
                field(unitCostLcy; Rec."Unit Cost (LCY)") { }
                field(expectedReceiptDate; Rec."Expected Receipt Date") { }
            }
        }
    }

    // WebshopVariantCode (PK_BC18_TAB field 50008 on Purchase Line) read at runtime — no
    // dependency on that extension. Blank if it isn't installed. See PKOptionalField.
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
