// Read-only API page over "Salesperson/Purchaser" (table 13). BC's api/v2.0 has no salesperson
// entity and the ODataV4 Salespersons_Purchasers web service is not published (and would be
// wiped by the next prod refresh anyway), so the middleware had no way to turn a sales order's
// Salesperson Code (e.g. SP-070) into the rep's NAME. The CO push needs the name for Deposco's
// customAttribute5 (per Deposco's Parker, 2026-09-22).
//
//   GET .../api/bmi/pk/v1.0/companies({companyId})/bmiSalespersons
page 60219 "PK Salesperson API"
{
    PageType = API;
    Caption = 'PK Salesperson';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiSalesperson';
    EntitySetName = 'bmiSalespersons';
    SourceTable = "Salesperson/Purchaser";
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
                field(code; Rec.Code) { }
                field(name; Rec.Name) { }
                field(email; Rec."E-Mail") { }
                field(phoneNo; Rec."Phone No.") { }
                field(blocked; Rec.Blocked) { }
            }
        }
    }
}
