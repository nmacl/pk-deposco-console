// Buffer/log table backing the shipment-tracking WRITE API. The middleware POSTs one row per
// Deposco outbound shipment; the API page applies it to the matching posted sales shipment
// (SLSS…) on insert and writes the outcome back onto the same row, so the POST response carries
// the result. Doubles as an audit trail of every tracking number pushed into BC.
//
// Same shape as "PK Inv Adjustment" (60210) and for the same reason: a page sourcing the posted
// table directly performs its Modify under the CALLER's rights, and the S2S user's license does
// not grant Modify on TableData 110 ("Your license does not grant ... Sales Shipment Header:
// Modify"). Routing through our own table + an elevated codeunit is the pattern that works.
table 60211 "PK Ship Tracking"
{
    Caption = 'PK Shipment Tracking';
    DataClassification = CustomerContent;
    InherentPermissions = RIMDX;
    InherentEntitlements = RIMDX;

    fields
    {
        field(1; "Entry No."; Integer) { Caption = 'Entry No.'; AutoIncrement = true; }

        // ── match keys: supply EITHER the shipment no. OR the external document no. ──
        field(10; "Shipment No."; Code[20]) { Caption = 'Shipment No.'; }
        field(11; "External Document No."; Code[35]) { Caption = 'External Document No.'; }

        // ── payload from Deposco /shipments/outboundShipments/{id} ──
        field(20; "Deposco Shipment No."; Code[20]) { Caption = 'Deposco Shipment No.'; }
        field(21; "Deposco Sales Order No."; Code[20]) { Caption = 'Deposco Sales Order No.'; }
        field(22; "Tracking No."; Text[250]) { Caption = 'Tracking No.'; }
        field(23; "Tracking URL"; Text[500]) { Caption = 'Tracking URL'; }
        field(24; Carrier; Text[50]) { Caption = 'Carrier'; }
        field(25; "Ship Via"; Text[100]) { Caption = 'Ship Via'; }
        field(26; "Ship Method"; Text[50]) { Caption = 'Ship Method'; }
        field(27; "Actual Ship Date"; DateTime) { Caption = 'Actual Ship Date'; }
        field(28; "Total Packages"; Integer) { Caption = 'Total Packages'; }
        field(29; "Total Weight"; Decimal) { Caption = 'Total Weight'; }
        field(30; "Container LPN"; Code[50]) { Caption = 'Container LPN'; }
        // Explicit erase. Blank payload fields mean "not supplied" (so a partial update can't
        // silently wipe a good tracking number); this flag is the only way to clear one — for a
        // voided shipment or a value written in error.
        field(31; "Clear Tracking"; Boolean) { Caption = 'Clear Tracking'; }

        // ── outcome, written back by the codeunit ──
        field(50; Applied; Boolean) { Caption = 'Applied'; Editable = false; }
        field(51; "Applied To"; Code[20]) { Caption = 'Applied To'; Editable = false; }
        field(52; "Error Message"; Text[250]) { Caption = 'Error Message'; Editable = false; }
        field(53; "Applied At"; DateTime) { Caption = 'Applied At'; Editable = false; }
    }

    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
        key(Shipment; "Shipment No.") { }
        key(ExtDoc; "External Document No.") { }
    }
}
