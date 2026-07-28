// Buffer/log table backing the inventory-adjustment WRITE API. The Node middleware
// POSTs one row per Deposco inventory adjustment; the API page posts it to an item
// journal on insert and writes the result (Posted / Item Ledger Entry No. / Error) back
// onto the same row, so the POST response carries the outcome. Also serves as an audit
// trail of every adjustment the middleware pushed into BC.
//
// Range 60200-60249 (see app.json). Reads share the bmi/pk namespace with the read pages.
table 60210 "PK Inv Adjustment"
{
    Caption = 'PK Inventory Adjustment';
    DataClassification = CustomerContent;
    // Grant data rights inherently so the limited S2S API user can log adjustments here without
    // the "PK Deposco Read API" permission set needing to be (re)assigned with write access.
    InherentPermissions = RIMDX;
    InherentEntitlements = RIMDX;

    fields
    {
        field(1; "Entry No."; Integer) { Caption = 'Entry No.'; AutoIncrement = true; }
        field(10; "Item No."; Code[20]) { Caption = 'Item No.'; TableRelation = Item; }
        field(11; "Variant Code"; Code[10])
        {
            Caption = 'Variant Code';
            TableRelation = "Item Variant".Code where("Item No." = field("Item No."));
        }
        field(12; "Location Code"; Code[10]) { Caption = 'Location Code'; TableRelation = Location; }
        // Signed delta straight from Deposco: + = increase (Positive Adjmt.), - = decrease (Negative Adjmt.).
        field(13; Quantity; Decimal) { Caption = 'Quantity'; }
        field(14; "Reason Code"; Code[10]) { Caption = 'Reason Code'; TableRelation = "Reason Code"; }
        field(15; "Posting Date"; Date) { Caption = 'Posting Date'; }
        // Optional. Left blank on a bin-mandatory location, the codeunit falls back to the
        // location's Adjustment Bin Code (BC's standard bin for item-journal adjustments).
        field(18; "Bin Code"; Code[20]) { Caption = 'Bin Code'; }
        // Deposco inventoryAdjustments self.id — dedupe key so a replayed poll can't double-post.
        field(16; "External Adjustment Id"; Code[35]) { Caption = 'External Adjustment Id'; }
        field(17; "Document No."; Code[20]) { Caption = 'Document No.'; }
        field(20; Posted; Boolean) { Caption = 'Posted'; Editable = false; }
        field(21; "Item Ledger Entry No."; Integer) { Caption = 'Item Ledger Entry No.'; Editable = false; }
        field(22; "Error Message"; Text[250]) { Caption = 'Error Message'; Editable = false; }
        // Actual signed qty posted after floor-at-zero clamping (may differ from Quantity).
        field(25; "Posted Quantity"; Decimal) { Caption = 'Posted Quantity'; Editable = false; }
    }

    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
        key(Ext; "External Adjustment Id") { }
    }
}
