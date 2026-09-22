// READ API page for posted TRANSFER shipments — the standard header fields plus the PK Deposco
// tracking payload written by PKTransferShipTrackingMgt. Twin of bmiSalesShipments (60208).
//
// Separate from page 60217 (the write buffer) on purpose: this one sources "Transfer Shipment
// Header" directly, which is safe because it never modifies. It is what the TO worker uses to
// (a) find the shipment(s) a transfer order posted and (b) tell "already tracked" from "never
// tracked" for the backfill.
//
//   GET .../api/bmi/pk/v1.0/companies({companyId})/bmiTransferShipments?$filter=transferOrderNo eq 'TRFO001523'
page 60218 "PK Transfer Shipment Read API"
{
    PageType = API;
    Caption = 'PK Transfer Shipment';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiTransferShipment';
    EntitySetName = 'bmiTransferShipments';
    SourceTable = "Transfer Shipment Header";
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
                field(no; Rec."No.") { }
                field(transferOrderNo; Rec."Transfer Order No.") { }
                field(externalDocumentNo; Rec."External Document No.") { }
                field(fromCode; Rec."Transfer-from Code") { }
                field(toCode; Rec."Transfer-to Code") { }
                field(postingDate; Rec."Posting Date") { }
                field(shipmentDate; Rec."Shipment Date") { }
                field(directTransfer; Rec."Direct Transfer") { }
                field(shippingAgentCode; Rec."Shipping Agent Code") { }
                field(deposcoShipmentNo; Rec."PK Deposco Shipment No.") { }
                field(deposcoSalesOrderNo; Rec."PK Deposco Sales Order No.") { }
                field(deposcoTrackingNo; Rec."PK Deposco Tracking No.") { }
                field(deposcoTrackingUrl; Rec."PK Deposco Tracking URL") { }
                field(deposcoCarrier; Rec."PK Deposco Carrier") { }
                field(deposcoShipVia; Rec."PK Deposco Ship Via") { }
                field(deposcoShipMethod; Rec."PK Deposco Ship Method") { }
                field(deposcoActualShipDate; Rec."PK Deposco Actual Ship Date") { }
                field(deposcoTotalPackages; Rec."PK Deposco Total Packages") { }
                field(deposcoTotalWeight; Rec."PK Deposco Total Weight") { }
                field(deposcoContainerLpn; Rec."PK Deposco Container LPN") { }
                field(deposcoSyncedAt; Rec."PK Deposco Synced At") { }
            }
        }
    }
}
