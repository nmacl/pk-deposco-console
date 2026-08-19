// WRITE API page: POST one fix request → PKIPaymentFixMgt runs it on insert and the response
// row carries matchCount + result (or the insert fails with the real error). Same
// execute-on-insert contract as bmiInventoryAdjustments, same api/bmi/pk/v1.0 surface.
//
//   POST .../api/bmi/pk/v1.0/companies({companyId})/bmiIPaymentFixes
//   { "fixAction": "LIST",   "customerNo": "S" }                        → matchCount + JSON rows
//   { "fixAction": "DELETE", "customerNo": "S" }                        → deletes, result = backup JSON
//   { "fixAction": "RENAME", "customerNo": "S", "newNo": "CTDI003931" } → renames the customer card
page 60214 "PK IPayment Fix API"
{
    PageType = API;
    Caption = 'PK IPayment Fix';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiIPaymentFix';
    EntitySetName = 'bmiIPaymentFixes';
    SourceTable = "PK IPayment Fix";
    ODataKeyFields = SystemId;
    DelayedInsert = true;
    InsertAllowed = true;
    ModifyAllowed = false;
    DeleteAllowed = false;
    Editable = true;

    layout
    {
        area(Content)
        {
            repeater(Group)
            {
                field(systemId; Rec.SystemId) { Editable = false; }
                field(entryNo; Rec."Entry No.") { Editable = false; }
                field(fixAction; Rec."Fix Action") { }
                field(customerNo; Rec."Customer No.") { }
                field(newNo; Rec."New No.") { }
                field(matchCount; Rec."Match Count") { Editable = false; }
                field(result; Rec.Result) { Editable = false; }
            }
        }
    }

    // Execute-on-insert: the codeunit only STAGES the outcome onto Rec; exiting true lets the
    // platform perform the single insert (authorized by the table's InherentPermissions).
    trigger OnInsertRecord(BelowxRec: Boolean): Boolean
    var
        Mgt: Codeunit "PK IPayment Fix Mgt";
    begin
        Mgt.Run(Rec);
        exit(true);
    end;
}
