// API page over sales order HEADERS whose only job is to expose a SHIP-ONLY posting action.
// BC's own api/v2.0 salesOrders entity offers only Microsoft.NAV.shipAndInvoice (verified against
// this environment's $metadata: cancel, cancelAndSend, makeCorrectiveCreditMemo, post, postAndSend,
// send, shipAndInvoice, makeInvoice, makeOrder, receiveAndInvoice, restart — no ship-only), which
// is why the middleware had to suppress the invoice half by zeroing Qty. to Invoice line by line.
// See "PK Sales Ship Mgt" for why that broke on orders with charge lines.
//
//   POST .../api/bmi/pk/v1.0/companies({companyId})/bmiSalesOrders({systemId})/Microsoft.NAV.postShipment
//
// Fields are read-only — the middleware still stages Qty. to Ship through the standard
// api/v2.0 salesOrderLines PATCH, exactly as it does today. This page adds the post, nothing else.
page 60209 "PK Sales Order API"
{
    PageType = API;
    Caption = 'PK Sales Order';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiSalesOrder';
    EntitySetName = 'bmiSalesOrders';
    SourceTable = "Sales Header";
    SourceTableView = where("Document Type" = const(Order));
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
                field(sellToCustomerNo; Rec."Sell-to Customer No.") { }
                field(externalDocumentNo; Rec."External Document No.") { }
                field(orderDate; Rec."Order Date") { }
                field(postingDate; Rec."Posting Date") { }
                field(completelyShipped; Rec."Completely Shipped") { }
            }
        }
    }

    // Ship-only post. Returns the posted shipment number in the action response so the caller can
    // match tracking write-back to that exact document rather than pre-stamping a synthetic ref
    // onto External Document No. (which clobbered the customer's PO number every attempt).
    [ServiceEnabled]
    procedure postShipment(var ActionContext: WebServiceActionContext)
    var
        Mgt: Codeunit "PK Sales Ship Mgt";
        SalesHeader: Record "Sales Header";
        ShipmentNo: Code[20];
    begin
        // Re-read under the codeunit so posting runs against a clean, committed record.
        SalesHeader.GetBySystemId(Rec.SystemId);
        ShipmentNo := Mgt.PostShipOnly(SalesHeader);
        ActionContext.SetObjectType(ObjectType::Page);
        ActionContext.SetObjectId(Page::"PK Sales Order API");
        ActionContext.AddEntityKey(Rec.FieldNo(SystemId), Rec.SystemId);
        ActionContext.SetResultCode(WebServiceActionResultCode::Get);
        if ShipmentNo = '' then
            Error('Sales order %1: posting reported success but no posted shipment was found.', SalesHeader."No.");
    end;

    // Cancels the reservation entries on every open item line — see "PK Sales Ship Mgt" for why
    // the middleware calls this before retrying a postShipment that failed on a stale/mismatched
    // reservation. Same headless shape as postShipment: no request body, acts by SystemId.
    //
    //   POST .../bmiSalesOrders({systemId})/Microsoft.NAV.cancelReservation
    [ServiceEnabled]
    procedure cancelReservation(var ActionContext: WebServiceActionContext)
    var
        Mgt: Codeunit "PK Sales Ship Mgt";
        SalesHeader: Record "Sales Header";
    begin
        SalesHeader.GetBySystemId(Rec.SystemId);
        Mgt.CancelReservations(SalesHeader);
        ActionContext.SetObjectType(ObjectType::Page);
        ActionContext.SetObjectId(Page::"PK Sales Order API");
        ActionContext.AddEntityKey(Rec.FieldNo(SystemId), Rec.SystemId);
        ActionContext.SetResultCode(WebServiceActionResultCode::Get);
    end;
}
