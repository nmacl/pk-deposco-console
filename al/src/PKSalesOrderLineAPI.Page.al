// Read-only API page: sales-order lines, flattened, in one GET.
// Returns Location Code + WebshopVariantCode (field 50027, owned by PK_BC18_TAB) directly.
// SourceTableView pins it to sales ORDER lines only.
page 60202 "PK Sales Order Line API"
{
    PageType = API;
    Caption = 'PK Sales Order Line';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiSalesOrderLine';
    EntitySetName = 'bmiSalesOrderLines';
    SourceTable = "Sales Line";
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
                field(quantityShipped; Rec."Quantity Shipped") { }
                field(qtyToShip; Rec."Qty. to Ship") { }
                field(unitPrice; Rec."Unit Price") { }
            }
        }
    }

    // WebshopVariantCode (PK_BC18_TAB field 50027 on Sales Line) read at runtime — no
    // dependency on that extension. Blank if it isn't installed. See PKOptionalField.
    var
        WebshopVarCode: Code[50];

    trigger OnAfterGetRecord()
    var
        OptField: Codeunit "PK Optional Field";
        RecRef: RecordRef;
    begin
        RecRef.GetTable(Rec);
        WebshopVarCode := OptField.AsCode(RecRef, 50027);
    end;
}
