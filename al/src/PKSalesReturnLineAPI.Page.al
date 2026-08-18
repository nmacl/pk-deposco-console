// API page over sales RETURN ORDER lines — read for the Deposco push (webshopVariantCode read
// at runtime via PKOptionalField, field 50027 on Sales Line, same as the sales-order line page),
// and WRITE for exactly one field: "Return Qty. to Receive", which the RO worker PATCHes to
// stage a partial/full receipt before firing bmiSalesReturnOrders/postReceipt. Staging lives on
// OUR page rather than an OData web service because prod refreshes wipe web services (the
// TransferOrderLines outage) but leave extension API pages alone.
page 60213 "PK Sales Return Line API"
{
    PageType = API;
    Caption = 'PK Sales Return Line';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiSalesReturnLine';
    EntitySetName = 'bmiSalesReturnLines';
    SourceTable = "Sales Line";
    SourceTableView = where("Document Type" = const("Return Order"));
    ODataKeyFields = SystemId;
    InsertAllowed = false;
    ModifyAllowed = true;
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
                field(locationCode; Rec."Location Code") { Editable = false; }
                field(description; Rec.Description) { Editable = false; }
                field(quantity; Rec.Quantity) { Editable = false; }
                field(returnQtyToReceive; Rec."Return Qty. to Receive") { }
                field(returnQtyReceived; Rec."Return Qty. Received") { Editable = false; }
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
        WebshopVarCode := OptField.AsCode(RecRef, 50027);
    end;
}
