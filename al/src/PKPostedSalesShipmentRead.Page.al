// READ API page for posted sales shipments — exposes the standard tracking fields alongside
// the PK Deposco payload written by PKShipTrackingMgt.
//
// Separate from page 60207 (bmiShipmentTrackings, the write buffer) on purpose: this one sources
// "Sales Shipment Header" directly, which is safe because it never modifies — the S2S license
// restriction only bites on Modify. Without this there is NO way to read the PK Deposco fields
// back over the API; they'd be visible only on the BC page.
//
//   GET .../api/bmi/pk/v1.0/companies({companyId})/bmiSalesShipments?$filter=orderNo eq 'PKSO057807'
page 60208 "PK Sales Shipment Read API"
{
    PageType = API;
    Caption = 'PK Sales Shipment';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiSalesShipment';
    EntitySetName = 'bmiSalesShipments';
    SourceTable = "Sales Shipment Header";
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
                field(orderNo; Rec."Order No.") { }
                field(externalDocumentNo; Rec."External Document No.") { }
                field(sellToCustomerNo; Rec."Sell-to Customer No.") { }
                field(locationCode; Rec."Location Code") { }
                field(postingDate; Rec."Posting Date") { }
                field(shippingAgentCode; Rec."Shipping Agent Code") { }
                field(packageTrackingNo; Rec."Package Tracking No.") { }
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
