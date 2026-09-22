// Buffer/log table backing the TRANSFER shipment-tracking WRITE API — twin of "PK Ship
// Tracking" (60211) for posted transfer shipments. The middleware POSTs one row per Deposco
// outbound shipment; the API page applies it to the matching posted transfer shipment on insert
// and writes the outcome back onto the row, so the POST response carries the result. Doubles as
// an audit trail of every tracking number pushed onto a transfer.
//
// Same InherentPermissions rationale as the other buffer tables: the limited S2S API user
// inserts request rows without the permission set needing write access.
table 60217 "PK Transfer Ship Tracking"
{
    Caption = 'PK Transfer Shipment Tracking';
    DataClassification = CustomerContent;
    InherentPermissions = RIMDX;
    InherentEntitlements = RIMDX;

    fields
    {
        field(1; "Entry No."; Integer) { Caption = 'Entry No.'; AutoIncrement = true; }

        // ── match keys: supply EITHER the posted shipment no. OR the transfer order no. ──
        field(10; "Shipment No."; Code[20]) { Caption = 'Shipment No.'; }
        field(11; "Transfer Order No."; Code[20]) { Caption = 'Transfer Order No.'; }

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
        // Explicit erase — blank payload fields mean "not supplied", never "wipe".
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
        key(Order; "Transfer Order No.") { }
    }
}
