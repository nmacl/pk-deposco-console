// Deposco shipment detail carried on the posted sales shipment (SLSS…).
//
// Why our own fields instead of borrowing UPG_PK_BC18_TAB's `PackageCarrier` (50130): this
// extension is deliberately standalone (dependencies: []), and writing another publisher's
// field is coupling we don't need. We own 60200-60249, so the Deposco payload lives here and
// survives whatever the vendor apps do. `PackageCarrier` is still mirrored best-effort by the
// API page (see PKPostedSalesShipmentAPI) for anything already reading it.
//
// The standard `Package Tracking No.` (Text[30]) is ALSO written by the API page, because that
// is where BC's own documents, emails and pages look. These fields are the richer superset:
// Tracking No. here is Text[250] so a multi-parcel shipment isn't truncated to one number.
tableextension 60230 "PK Sales Shipment Ext" extends "Sales Shipment Header"
{
    // NOTE: InherentPermissions/InherentEntitlements are NOT customizable on a tableextension
    // (AL0246). The elevated write lives in codeunit "PK Ship Tracking Mgt" instead.

    fields
    {
        field(60200; "PK Deposco Shipment No."; Code[20])
        {
            Caption = 'Deposco Shipment No.';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60201; "PK Deposco Sales Order No."; Code[20])
        {
            // Deposco's child fulfillment order (e.g. SO12502) — not the BC sales order.
            Caption = 'Deposco Sales Order No.';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60202; "PK Deposco Tracking No."; Text[250])
        {
            // Comma-separated when one BC shipment covers several Deposco parcels.
            Caption = 'Deposco Tracking No.';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60203; "PK Deposco Tracking URL"; Text[500])
        {
            // Full clickable link (Deposco returns a base URL; the middleware appends the number).
            Caption = 'Deposco Tracking URL';
            DataClassification = CustomerContent;
            Editable = false;
            ExtendedDatatype = URL;
        }
        field(60204; "PK Deposco Carrier"; Text[50])
        {
            // Deposco `shipVendor` — already emitted as 'FedEx' / 'UPS'.
            Caption = 'Deposco Carrier';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60205; "PK Deposco Ship Via"; Text[100])
        {
            // Deposco `shipVia`, e.g. 'eHub Fedex Express Saver'.
            Caption = 'Deposco Ship Via';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60206; "PK Deposco Ship Method"; Text[50])
        {
            Caption = 'Deposco Ship Method';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60207; "PK Deposco Actual Ship Date"; DateTime)
        {
            Caption = 'Deposco Actual Ship Date';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60208; "PK Deposco Total Packages"; Integer)
        {
            Caption = 'Deposco Total Packages';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60209; "PK Deposco Total Weight"; Decimal)
        {
            Caption = 'Deposco Total Weight';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60210; "PK Deposco Container LPN"; Code[50])
        {
            // Deposco shippedContainers LPN, e.g. 'SO12502--HIVE--1'.
            Caption = 'Deposco Container LPN';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60211; "PK Deposco Synced At"; DateTime)
        {
            // Stamped by the API page on every write — tells you whether a blank tracking number
            // means "never synced" or "synced, Deposco had nothing".
            Caption = 'Deposco Synced At';
            DataClassification = CustomerContent;
            Editable = false;
        }
    }
}
