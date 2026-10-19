// Read-only API page: transfer-order HEADERS, flattened, from the standard "Transfer Header"
// table — NO dependency on the OData `TransferOrders` web service (which gets wiped by prod
// refreshes; 404'd in PILOT 2026-07-27). Distinct EntitySetName from Blue Moon's bmiTransferOrders
// so both coexist in the shared bmi/pk namespace. Feeds sync-to's list + header-field reads so
// the transfer PUSH no longer needs the OData feed. (Lines already come from bmiTransferOrderLine.)
page 60206 "PK Transfer Order Header API"
{
    PageType = API;
    Caption = 'PK Transfer Order Header';
    APIPublisher = 'bmi';
    APIGroup = 'pk';
    APIVersion = 'v1.0';
    EntityName = 'bmiTransferHeader';
    EntitySetName = 'bmiTransferHeaders';
    SourceTable = "Transfer Header";
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
                field(directTransfer; Rec."Direct Transfer") { }
                field(fromCode; Rec."Transfer-from Code") { }
                field(toCode; Rec."Transfer-to Code") { }
                field(postingDate; Rec."Posting Date") { }
                field(receiptDate; Rec."Receipt Date") { }
                field(shipmentDate; Rec."Shipment Date") { }
                field(toName; Rec."Transfer-to Name") { }
                field(toAddress; Rec."Transfer-to Address") { }
                field(toAddress2; Rec."Transfer-to Address 2") { }
                field(toCity; Rec."Transfer-to City") { }
                field(toCounty; Rec."Transfer-to County") { }
                field(toPostCode; Rec."Transfer-to Post Code") { }
                field(toContact; Rec."Transfer-to Contact") { }
                field(toCountry; Rec."Trsf.-to Country/Region Code") { }
                // 2.19: the transfer's OWN carrier — ship via must come from here, not the source SO.
                field(shippingAgentCode; Rec."Shipping Agent Code") { }
                field(shippingAgentServiceCode; Rec."Shipping Agent Service Code") { }
                field(shipmentMethodCode; Rec."Shipment Method Code") { }
                // Lanham E-Ship's "E-Ship Agent Service" on the transfer header, found by field NAME
                // at runtime (their field number isn't known here and we take no dependency). Blank
                // when the field doesn't exist.
                field(eShipAgentService; EShipAgentService) { }
                // 2.23: Deposco "Current Status" mirrored onto the open transfer (see the tableextension).
                field(deposcoStatus; Rec."PK Deposco Status") { }
                field(deposcoStatusAt; Rec."PK Deposco Status At") { }
            }
        }
    }

    var
        EShipAgentService: Text[100];

    // Write the Deposco status onto the header. Bound action so the page itself stays read-only:
    //   POST .../bmiTransferHeaders({systemId})/Microsoft.NAV.setDeposcoStatus  { "status": "Picking" }
    [ServiceEnabled]
    procedure setDeposcoStatus(var ActionContext: WebServiceActionContext; status: Text[30])
    var
        Mgt: Codeunit "PK Transfer Deposco Status Mgt";
        TransferHeader: Record "Transfer Header";
    begin
        TransferHeader.GetBySystemId(Rec.SystemId);
        Mgt.Apply(TransferHeader, status);
        ActionContext.SetObjectType(ObjectType::Page);
        ActionContext.SetObjectId(Page::"PK Transfer Order Header API");
        ActionContext.AddEntityKey(Rec.FieldNo(SystemId), Rec.SystemId);
        ActionContext.SetResultCode(WebServiceActionResultCode::Get);
    end;

    trigger OnAfterGetRecord()
    var
        OptField: Codeunit "PK Optional Field";
        RecRef: RecordRef;
    begin
        RecRef.GetTable(Rec);
        EShipAgentService := CopyStr(OptField.FindTextByName(RecRef, 'E-Ship Agent Service'), 1, MaxStrLen(EShipAgentService));
    end;
}
