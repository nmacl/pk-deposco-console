// WRITE API page: POST one Deposco tracking payload → BC stamps it onto the matching posted
// sales shipment (SLSS…) on insert, and the response row carries applied=true + appliedTo (or
// the insert fails with the reason). Same api/bmi/pk/v1.0 namespace as everything else.
//
//   POST .../api/bmi/pk/v1.0/companies({companyId})/bmiPostedSalesShipments
//   { "externalDocumentNo": "SHIP-DISO209418-1754...", "deposcoShipmentNo": "205",
//     "deposcoSalesOrderNo": "SO12502", "trackingNo": "875056826520",
//     "trackingUrl": "https://www.fedex.com/fedextrack/?trknbr=875056826520",
//     "carrier": "FedEx", "shipVia": "eHub Fedex Express Saver" }
//
// Match by `shipmentNo` (exact SLSS no.) or `externalDocumentNo` (the SHIP-{soNo}-{epoch} ref
// sync-co.ts stamps immediately before posting). NOT a page over Sales Shipment Header — that
// modifies under the caller's rights and 403s on the S2S license. See PKShipTrackingMgt.
page 60207 "PK Posted Sales Shipment API"
{
    PageType = API;
    Caption = 'PK Shipment Tracking';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiShipmentTracking';
    EntitySetName = 'bmiShipmentTrackings';
    SourceTable = "PK Ship Tracking";
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
                field(externalDocumentNo; Rec."External Document No.") { }
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
                field(orderFreightTotal; Rec."Order Freight Total") { }
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
        Mgt: Codeunit "PK Ship Tracking Mgt";
    begin
        Mgt.LogAndApply(Rec);
        exit(false);   // the codeunit already inserted; don't let the platform insert again
    end;
}
