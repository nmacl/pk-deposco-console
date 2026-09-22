// WRITE API page: POST one Deposco tracking payload → BC stamps it onto the matching posted
// TRANSFER shipment on insert; the response row carries applied=true + appliedTo (or the insert
// fails with the reason). Twin of bmiShipmentTrackings (page 60207) for sales shipments.
//
//   POST .../api/bmi/pk/v1.0/companies({companyId})/bmiTransferShipmentTrackings
//   { "shipmentNo": "TSHP001234", "deposcoShipmentNo": "3105", "deposcoSalesOrderNo": "SO5992",
//     "trackingNo": "1Z999AA10123456784", "trackingUrl": "https://...", "carrier": "UPS",
//     "shipVia": "eHub Ups Ground" }
//
// Match by `shipmentNo` (exact posted no.) or `transferOrderNo` (only when the order posted one
// shipment). NOT a page over Transfer Shipment Header — that modifies under the caller's rights
// and 403s on the S2S license. See PKTransferShipTrackingMgt.
page 60217 "PK Transfer Ship Tracking API"
{
    PageType = API;
    Caption = 'PK Transfer Shipment Tracking';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiTransferShipmentTracking';
    EntitySetName = 'bmiTransferShipmentTrackings';
    SourceTable = "PK Transfer Ship Tracking";
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
                field(shipmentNo; Rec."Shipment No.") { }
                field(transferOrderNo; Rec."Transfer Order No.") { }
                field(deposcoShipmentNo; Rec."Deposco Shipment No.") { }
                field(deposcoSalesOrderNo; Rec."Deposco Sales Order No.") { }
                field(trackingNo; Rec."Tracking No.") { }
                field(trackingUrl; Rec."Tracking URL") { }
                field(carrier; Rec.Carrier) { }
                field(shipVia; Rec."Ship Via") { }
                field(shipMethod; Rec."Ship Method") { }
                field(actualShipDate; Rec."Actual Ship Date") { }
                field(totalPackages; Rec."Total Packages") { }
                field(totalWeight; Rec."Total Weight") { }
                field(containerLpn; Rec."Container LPN") { }
                field(clearTracking; Rec."Clear Tracking") { }
                field(applied; Rec.Applied) { Editable = false; }
                field(appliedTo; Rec."Applied To") { Editable = false; }
                field(appliedAt; Rec."Applied At") { Editable = false; }
                field(errorMessage; Rec."Error Message") { Editable = false; }
            }
        }
    }

    // Apply-on-insert. The codeunit performs BOTH the posted-shipment Modify and this row's
    // Insert, so everything runs with its elevated Permissions rather than the caller's.
    trigger OnInsertRecord(BelowxRec: Boolean): Boolean
    var
        Mgt: Codeunit "PK Transfer Ship Tracking Mgt";
    begin
        Mgt.LogAndApply(Rec);
        exit(false);   // the codeunit already inserted; don't let the platform insert again
    end;
}
