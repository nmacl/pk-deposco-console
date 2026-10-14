// Read-only API pages over BC manufacturing Production Orders (tables 5405/5406/5407). BC's
// api/v2.0 has no production-order entity and no OData web service is published, so the
// middleware could not see them at all. Asked for 2026-10-14 (Nicholas): PROD orders at Westerly
// need to reach Deposco. Headers + output lines + components, flattened; webshopVariantCode is
// looked up by field NAME so no dependency on PK_BC18_TAB.
//
//   GET .../api/bmi/pk/v1.0/companies({companyId})/bmiProductionOrders?$filter=status eq 'Released'
//   GET .../bmiProductionOrderLines?$filter=prodOrderNo eq 'PROD001234'
//   GET .../bmiProdOrderComponents?$filter=prodOrderNo eq 'PROD001234'
page 60220 "PK Production Order API"
{
    PageType = API;
    Caption = 'PK Production Order';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiProductionOrder';
    EntitySetName = 'bmiProductionOrders';
    SourceTable = "Production Order";
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
                field(no; Rec."No.") { }
                field(description; Rec.Description) { }
                field(sourceType; Rec."Source Type") { }
                field(sourceNo; Rec."Source No.") { }
                field(variantCode; Rec."Variant Code") { }
                field(quantity; Rec.Quantity) { }
                field(locationCode; Rec."Location Code") { }
                field(binCode; Rec."Bin Code") { }
                field(creationDate; Rec."Creation Date") { }
                field(startingDate; Rec."Starting Date") { }
                field(endingDate; Rec."Ending Date") { }
                field(dueDate; Rec."Due Date") { }
                field(finishedDate; Rec."Finished Date") { }
                field(lastModifiedDateTime; Rec.SystemModifiedAt) { }
            }
        }
    }
}
