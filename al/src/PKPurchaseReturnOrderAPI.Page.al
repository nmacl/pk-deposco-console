// API page over purchase RETURN ORDER headers (PROD…, "return to vendor") — BC's api/v2.0 has no
// purchase-return entity and no OData web service is published. Ops (Nicholas, 2026-10-14) wants
// these picked and shipped out of Westerly through Deposco like a sales order. Read-only; the
// post action comes with the worker.
//
//   GET .../api/bmi/pk/v1.0/companies({companyId})/bmiPurchaseReturnOrders?$filter=status eq 'Released'
page 60223 "PK Purchase Return Order API"
{
    PageType = API;
    Caption = 'PK Purchase Return Order';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiPurchaseReturnOrder';
    EntitySetName = 'bmiPurchaseReturnOrders';
    SourceTable = "Purchase Header";
    SourceTableView = where("Document Type" = const("Return Order"));
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
                field(status; Rec.Status) { }
                field(buyFromVendorNo; Rec."Buy-from Vendor No.") { }
                field(buyFromVendorName; Rec."Buy-from Vendor Name") { }
                field(buyFromAddress; Rec."Buy-from Address") { }
                field(buyFromAddress2; Rec."Buy-from Address 2") { }
                field(buyFromCity; Rec."Buy-from City") { }
                field(buyFromCounty; Rec."Buy-from County") { }
                field(buyFromPostCode; Rec."Buy-from Post Code") { }
                field(buyFromCountry; Rec."Buy-from Country/Region Code") { }
                field(buyFromContact; Rec."Buy-from Contact") { }
                field(shipToName; Rec."Ship-to Name") { }
                field(shipToAddress; Rec."Ship-to Address") { }
                field(shipToAddress2; Rec."Ship-to Address 2") { }
                field(shipToCity; Rec."Ship-to City") { }
                field(shipToCounty; Rec."Ship-to County") { }
                field(shipToPostCode; Rec."Ship-to Post Code") { }
                field(shipToCountry; Rec."Ship-to Country/Region Code") { }
                field(shipToContact; Rec."Ship-to Contact") { }
                field(locationCode; Rec."Location Code") { }
                field(orderDate; Rec."Order Date") { }
                field(postingDate; Rec."Posting Date") { }
                field(documentDate; Rec."Document Date") { }
                field(vendorAuthorizationNo; Rec."Vendor Authorization No.") { }
                field(eShipAgentService; EShipAgentService) { }
                field(lastReturnShipmentNo; Rec."Last Return Shipment No.") { }
            }
        }
    }

    // Ship-only post of the return (Purch.-Post Ship=true, Invoice=false). The caller re-GETs the
    // entity and reads lastReturnShipmentNo for the posted document. Mirror of
    // bmiSalesReturnOrders/postReceipt.
    //
    //   POST .../bmiPurchaseReturnOrders({systemId})/Microsoft.NAV.postShipment
    [ServiceEnabled]
    procedure postShipment(var ActionContext: WebServiceActionContext)
    var
        Mgt: Codeunit "PK Purch Return Ship Mgt";
        PurchHeader: Record "Purchase Header";
        ShipmentNo: Code[20];
    begin
        PurchHeader.GetBySystemId(Rec.SystemId);
        ShipmentNo := Mgt.PostShipOnly(PurchHeader);
        ActionContext.SetObjectType(ObjectType::Page);
        ActionContext.SetObjectId(Page::"PK Purchase Return Order API");
        ActionContext.AddEntityKey(Rec.FieldNo(SystemId), Rec.SystemId);
        ActionContext.SetResultCode(WebServiceActionResultCode::Get);
        if ShipmentNo = '' then
            Error('Purchase return order %1: posting reported success but no posted return shipment was found.', PurchHeader."No.");
    end;

    var
        EShipAgentService: Text[100];

    trigger OnAfterGetRecord()
    var
        OptField: Codeunit "PK Optional Field";
        RecRef: RecordRef;
    begin
        RecRef.GetTable(Rec);
        EShipAgentService := CopyStr(OptField.FindTextByName(RecRef, 'E-Ship Agent Service'), 1, MaxStrLen(EShipAgentService));
    end;
}
