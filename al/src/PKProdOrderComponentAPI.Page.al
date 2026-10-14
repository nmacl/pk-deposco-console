// Components of a production order (what gets consumed — the pick). See PKProductionOrderAPI.Page.al.
page 60222 "PK Prod. Order Component API"
{
    PageType = API;
    Caption = 'PK Prod. Order Component';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiProdOrderComponent';
    EntitySetName = 'bmiProdOrderComponents';
    SourceTable = "Prod. Order Component";
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
                field(status; Rec.Status) { }
                field(prodOrderNo; Rec."Prod. Order No.") { }
                field(prodOrderLineNo; Rec."Prod. Order Line No.") { }
                field(lineNo; Rec."Line No.") { }
                field(itemNo; Rec."Item No.") { }
                field(variantCode; Rec."Variant Code") { }
                field(webshopVariantCode; WebshopVarCode) { }
                field(description; Rec.Description) { }
                field(locationCode; Rec."Location Code") { }
                field(binCode; Rec."Bin Code") { }
                field(quantityPer; Rec."Quantity per") { }
                field(expectedQuantity; Rec."Expected Quantity") { }
                field(remainingQuantity; Rec."Remaining Quantity") { }
                field(unitOfMeasureCode; Rec."Unit of Measure Code") { }
                field(flushingMethod; Rec."Flushing Method") { }
                field(dueDate; Rec."Due Date") { }
            }
        }
    }

    var
        WebshopVarCode: Text[100];

    trigger OnAfterGetRecord()
    var
        OptField: Codeunit "PK Optional Field";
        RecRef: RecordRef;
    begin
        RecRef.GetTable(Rec);
        WebshopVarCode := CopyStr(OptField.FindTextByName(RecRef, 'WebshopVariantCode'), 1, MaxStrLen(WebshopVarCode));
    end;
}
