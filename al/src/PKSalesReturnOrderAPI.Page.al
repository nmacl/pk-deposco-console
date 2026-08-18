// API page over sales RETURN ORDER headers (SRTO…) — BC's api/v2.0 has no sales-return entity
// at all, and every other page here is pinned to Document Type = Order, so return orders were
// invisible to the middleware. Exposes the headers the RO worker lists plus a RECEIVE-ONLY
// posting action (see "PK Sales Return Rcpt Mgt" for why receive-only):
//
//   POST .../api/bmi/pk/v1.0/companies({companyId})/bmiSalesReturnOrders({systemId})/Microsoft.NAV.postReceipt
//
// Fields are read-only — the middleware stages "Return Qty. to Receive" through the
// bmiSalesReturnLines PATCH (our own page, so a prod refresh can't wipe the write path the way
// it wipes OData web services). lastReturnReceiptNo lets the caller re-GET after the action to
// log the posted document number.
page 60212 "PK Sales Return Order API"
{
    PageType = API;
    Caption = 'PK Sales Return Order';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiSalesReturnOrder';
    EntitySetName = 'bmiSalesReturnOrders';
    SourceTable = "Sales Header";
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
                field(sellToCustomerNo; Rec."Sell-to Customer No.") { }
                field(sellToCustomerName; Rec."Sell-to Customer Name") { }
                field(externalDocumentNo; Rec."External Document No.") { }
                field(orderDate; Rec."Order Date") { }
                field(postingDate; Rec."Posting Date") { }
                field(locationCode; Rec."Location Code") { }
                field(lastReturnReceiptNo; Rec."Last Return Receipt No.") { }
            }
        }
    }

    // Receive-only post. The caller re-GETs the entity afterwards and reads lastReturnReceiptNo
    // for the posted document number (same convention as bmiSalesOrders/postShipment).
    [ServiceEnabled]
    procedure postReceipt(var ActionContext: WebServiceActionContext)
    var
        Mgt: Codeunit "PK Sales Return Rcpt Mgt";
        SalesHeader: Record "Sales Header";
        ReceiptNo: Code[20];
    begin
        // Re-read under the codeunit so posting runs against a clean, committed record.
        SalesHeader.GetBySystemId(Rec.SystemId);
        ReceiptNo := Mgt.PostReceiveOnly(SalesHeader);
        ActionContext.SetObjectType(ObjectType::Page);
        ActionContext.SetObjectId(Page::"PK Sales Return Order API");
        ActionContext.AddEntityKey(Rec.FieldNo(SystemId), Rec.SystemId);
        ActionContext.SetResultCode(WebServiceActionResultCode::Get);
        if ReceiptNo = '' then
            Error('Return order %1: posting reported success but no posted return receipt was found.', SalesHeader."No.");
    end;
}
