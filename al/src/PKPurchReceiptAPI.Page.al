// WRITE API page: POST one receive-only purchase receipt → "PK Purch Receive Mgt" posts it on
// insert and the response row carries postedReceiptNo (or the insert fails with the posting
// error). Replaces the old pull flow of Vendor-Invoice-No.-stamp + per-line PATCH +
// Microsoft.NAV.receiveAndInvoice — one call, one transaction, no invoice pass at all.
//
//   POST .../api/bmi/pk/v1.0/companies({companyId})/bmiPurchaseReceipts
//   { "orderNo": "PO12345", "deposcoReceiptRef": "RCPT-PO12345-1755791234567",
//     "lines": "10000:5,30000:2" }
page 60215 "PK Purch Receipt API"
{
    PageType = API;
    Caption = 'PK Purchase Receipt';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiPurchaseReceipt';
    EntitySetName = 'bmiPurchaseReceipts';
    SourceTable = "PK Purch Receipt";
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
                field(orderNo; Rec."Order No.") { }
                field(deposcoReceiptRef; Rec."Deposco Receipt Ref") { }
                field(lines; Rec.Lines) { }
                field(postedReceiptNo; Rec."Posted Receipt No.") { Editable = false; }
                field(linesReceived; Rec."Lines Received") { Editable = false; }
                field(alreadyPosted; Rec."Already Posted") { Editable = false; }
            }
        }
    }

    // Execute-on-insert: the codeunit only STAGES the outcome onto Rec; exiting true lets the
    // platform perform the single insert (authorized by the table's InherentPermissions).
    trigger OnInsertRecord(BelowxRec: Boolean): Boolean
    var
        Mgt: Codeunit "PK Purch Receive Mgt";
    begin
        Mgt.Post(Rec);
        exit(true);
    end;
}
