// Deposco outbound tracking on POSTED TRANSFER SHIPMENTS — the transfer-side twin of
// "PK Sales Shipment Ext" (60230). A WMS-origin transfer order is pushed to Deposco as a
// customerOrder and ships like any sales order, but BC's Transfer Shipment Header (5744) has no
// "Package Tracking No." at all (confirmed in the BC27 base app), so everything lives here.
//
// Written ONLY by "PK Transfer Ship Tracking Mgt" (elevated Modify) via the
// bmiTransferShipmentTrackings API page — never from the UI (Editable = false throughout).
//
// Field numbers start at 60400: field IDs in this app are tracked across the WHOLE app by BC's
// schema sync (see the warning in PKSalesHeaderExt.TableExt.al), so this band is kept clear of
// every other tableextension in al/src.
tableextension 60237 "PK Transfer Shipment Ext" extends "Transfer Shipment Header"
{
    fields
    {
        field(60400; "PK Deposco Shipment No."; Code[20])
        {
            Caption = 'Deposco Shipment No.';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60401; "PK Deposco Sales Order No."; Code[20])
        {
            Caption = 'Deposco Sales Order No.';
            DataClassification = CustomerContent;
            Editable = false;
        }
        // Comma-separated when one BC shipment covers several parcels (same convention as the
        // sales side). Text[250] holds ~17 UPS/FedEx numbers.
        field(60402; "PK Deposco Tracking No."; Text[250])
        {
            Caption = 'Deposco Tracking No.';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60403; "PK Deposco Tracking URL"; Text[500])
        {
            Caption = 'Deposco Tracking URL';
            DataClassification = CustomerContent;
            Editable = false;
            ExtendedDatatype = URL;
        }
        field(60404; "PK Deposco Carrier"; Text[50])
        {
            Caption = 'Deposco Carrier';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60405; "PK Deposco Ship Via"; Text[100])
        {
            Caption = 'Deposco Ship Via';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60406; "PK Deposco Ship Method"; Text[50])
        {
            Caption = 'Deposco Ship Method';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60407; "PK Deposco Actual Ship Date"; DateTime)
        {
            Caption = 'Deposco Actual Ship Date';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60408; "PK Deposco Total Packages"; Integer)
        {
            Caption = 'Deposco Total Packages';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60409; "PK Deposco Total Weight"; Decimal)
        {
            Caption = 'Deposco Total Weight';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60410; "PK Deposco Container LPN"; Code[50])
        {
            Caption = 'Deposco Container LPN';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60411; "PK Deposco Synced At"; DateTime)
        {
            Caption = 'Deposco Synced At';
            DataClassification = CustomerContent;
            Editable = false;
        }
    }
}
