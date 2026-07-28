// WRITE API page: POST one inventory adjustment → BC posts it to the PKDEP/DEPOSCO item
// journal on insert and the response row carries posted=true + itemLedgerEntryNo (or the
// insert fails with the posting error). Publishes under the SAME api/bmi/pk/v1.0 namespace
// as the read pages, so the middleware hits one surface.
//
//   POST .../api/bmi/pk/v1.0/companies({companyId})/bmiInventoryAdjustments
//   { "itemNo": "10000", "variantCode": "BLK-LG", "locationCode": "HIVE",
//     "quantity": -12, "reasonCode": "DEPOSCO", "externalAdjustmentId": "111" }
page 60203 "PK Inv Adjustment API"
{
    PageType = API;
    Caption = 'PK Inventory Adjustment';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiInventoryAdjustment';
    EntitySetName = 'bmiInventoryAdjustments';
    SourceTable = "PK Inv Adjustment";
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
                field(itemNo; Rec."Item No.") { }
                field(variantCode; Rec."Variant Code") { }
                field(locationCode; Rec."Location Code") { }
                field(binCode; Rec."Bin Code") { }
                field(quantity; Rec.Quantity) { }
                field(reasonCode; Rec."Reason Code") { }
                field(postingDate; Rec."Posting Date") { }
                field(externalAdjustmentId; Rec."External Adjustment Id") { }
                field(documentNo; Rec."Document No.") { }
                field(posted; Rec.Posted) { Editable = false; }
                field(postedQuantity; Rec."Posted Quantity") { Editable = false; }
                field(itemLedgerEntryNo; Rec."Item Ledger Entry No.") { Editable = false; }
                field(errorMessage; Rec."Error Message") { Editable = false; }
            }
        }
    }

    // Post-on-insert: a single POST creates + posts + returns the outcome. Idempotent on
    // externalAdjustmentId so a replayed Deposco poll cannot double-post the same adjustment.
    trigger OnInsertRecord(BelowxRec: Boolean): Boolean
    var
        Mgt: Codeunit "PK Inv Adjustment Mgt";
    begin
        // Idempotency check, journal post, and audit-row insert all happen inside the codeunit
        // (elevated permissions) so the limited S2S API user needs no direct table rights.
        Mgt.Post(Rec);
        exit(true);
    end;
}
