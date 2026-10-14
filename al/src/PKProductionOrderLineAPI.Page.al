// Output lines of a production order (what gets made). See PKProductionOrderAPI.Page.al.
page 60221 "PK Production Order Line API"
{
    PageType = API;
    Caption = 'PK Production Order Line';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiProductionOrderLine';
    EntitySetName = 'bmiProductionOrderLines';
    SourceTable = "Prod. Order Line";
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
                field(lineNo; Rec."Line No.") { }
                field(itemNo; Rec."Item No.") { }
                field(variantCode; Rec."Variant Code") { }
                field(webshopVariantCode; WebshopVarCode) { }
                field(description; Rec.Description) { }
                field(locationCode; Rec."Location Code") { }
                field(binCode; Rec."Bin Code") { }
                field(quantity; Rec.Quantity) { }
                field(finishedQuantity; Rec."Finished Quantity") { }
                field(remainingQuantity; Rec."Remaining Quantity") { }
                field(unitOfMeasureCode; Rec."Unit of Measure Code") { }
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
