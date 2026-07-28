// Read-only API page: item ledger ENTRIES of the two adjustment types, flattened. Feeds the
// BC→Deposco push half of the inventory-adjustments sync — the worker polls entries with
// entryNo gt <cursor>, skips the ones WE posted (documentNo starts 'DEP', the BC-side
// echo-breaker), maps Item+Variant → WebshopVariantCode, and POSTs them to Deposco.
// (Item Ledger Entry isn't published as an OData query object, hence this page.)
page 60204 "PK Item Ledger Entry API"
{
    PageType = API;
    Caption = 'PK Item Ledger Entry';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiItemLedgerEntry';
    EntitySetName = 'bmiItemLedgerEntries';
    SourceTable = "Item Ledger Entry";
    SourceTableView = where("Entry Type" = filter("Positive Adjmt." | "Negative Adjmt."));
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
                field(entryNo; Rec."Entry No.") { }
                field(itemNo; Rec."Item No.") { }
                field(variantCode; Rec."Variant Code") { }
                field(locationCode; Rec."Location Code") { }
                field(quantity; Rec.Quantity) { }
                field(entryType; Rec."Entry Type") { }
                field(postingDate; Rec."Posting Date") { }
                field(documentNo; Rec."Document No.") { }
            }
        }
    }
}
