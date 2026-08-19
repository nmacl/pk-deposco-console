// Deposco-sourced counterpart of PK_BC_customization's "Calc Actual Shipping Cost" button
// (Sales Header Ext.CalcActualShippingCost). Same shape — vendor freight from the order's linked
// posted purchase invoices, plus carrier freight, marked up by Sales & Receivables Setup
// "Sales Shipping Markup %", rounded UP to the cent, written to Sales Header ShippingCost — but
// the carrier component is "PK Deposco Order Freight Tot" summed across the order's posted
// shipments instead of Lanham LAX Posted Package label costs.
//
// Two freights, and third party separates them:
//   OUTBOUND (Deposco) — on a third-party order this rides the customer's own carrier account,
//     so PK never pays it and there is nothing to recharge. Excluded.
//   INBOUND (vendor PO) — PK's real cost either way, marked up and recovered either way.
//
// For a normal order the header fields are all this button writes: Release & Reopen rebuilds the
// customer-facing freight G/L line from them, exactly as it does for the old button. For a
// third-party order it also writes the line itself, because release declines to manage freight
// lines on those at all — see WriteFreightLine.
//
// Every field on another app's table goes through "PK Optional Field" by number + NAME, because
// PK_BC18_TAB is published by UPG on PILOT and by Redefine on Production (see codeunit 60221).
// Unlike the display columns, a silent no-op here would mean a wrongly priced order, so missing
// target fields ERROR instead of degrading.
codeunit 60225 "PK Deposco Ship Cost"
{
    // Clicked by a warehouse/CS user in the client, not by the Entra app — so the
    // "PK Deposco Read API" permission set, which is written for the S2S caller, does not apply
    // to them. Without these the platform refuses with "Your license does not grant you ...
    // CodeUnit 60225 ... Execute" (InherentEntitlements clears that) and then "the current
    // permissions prevented the action" (InherentPermissions clears that). Table access is
    // declared here rather than relying on whoever clicks the button holding it.
    Permissions = tabledata "Sales Header" = RM,
                  tabledata "Sales Line" = RIM,
                  tabledata "Sales Shipment Header" = R,
                  tabledata "Purch. Inv. Header" = R,
                  tabledata "Purch. Inv. Line" = R,
                  tabledata "Purchases & Payables Setup" = R,
                  tabledata "Sales & Receivables Setup" = R;
    InherentPermissions = X;
    InherentEntitlements = X;

    procedure CalcDeposcoShippingCost(var SalesHeader: Record "Sales Header")
    var
        SalesSetup: Record "Sales & Receivables Setup";
        Opt: Codeunit "PK Optional Field";
        HdrRef: RecordRef;
        SetupRef: RecordRef;
        PoFreight: Decimal;
        DeposcoFreight: Decimal;
        MarkupPct: Decimal;
        Total: Decimal;
        HasShipments: Boolean;
        ThirdParty: Boolean;
        NoFreightYetQst: Label 'Posted shipments exist for %1, but Deposco has not reported an order freight total yet — the order may not be Complete in Deposco. Continue with vendor PO freight only?';
        MarkupMissingErr: Label 'Sales & Receivables Setup field 50003 "Sales Shipping Markup %" was not found. Is PK_BC18_TAB installed in this environment?';
        TargetMissingErr: Label 'Sales Header field %1 "%2" was not found. Is PK_BC18_TAB installed in this environment?';
    begin
        SalesHeader.TestField(Status, SalesHeader.Status::Open);

        PoFreight := LinkedPoFreight(SalesHeader."No.");

        // Third-party freight rides the customer's own carrier account, so the OUTBOUND parcel
        // is never PK's cost and there is nothing to recharge. INBOUND vendor freight still is
        // PK's cost and is still recoverable, so it stays in the calculation either way.
        ThirdParty := IsThirdPartyFreight(SalesHeader);
        if not ThirdParty then begin
            DeposcoFreight := DeposcoOrderFreight(SalesHeader."No.", HasShipments);

            // The freight total is written once, when Deposco reports the customer order
            // Complete. Shipments with no freight yet almost always mean "clicked too early",
            // so say so instead of quietly writing a number missing its carrier component.
            if HasShipments and (DeposcoFreight = 0) then
                if not Confirm(NoFreightYetQst, false, SalesHeader."No.") then
                    exit;
        end;

        // Nothing to calculate is a no-op, not news. Silent by design: the button speaks only
        // when something is wrong. On a third-party order this is the normal exit — Deposco
        // freight was never read, and vendor PO freight is usually absent too.
        if (PoFreight = 0) and (DeposcoFreight = 0) then
            exit;

        SalesSetup.Get();
        SetupRef.GetTable(SalesSetup);
        if not Opt.TryGetDecimal(SetupRef, 50003, 'Sales Shipping Markup %', MarkupPct) then
            Error(MarkupMissingErr);

        // Markup 0 deliberately passes freight through at cost rather than mirroring the old
        // button's quirk of computing nothing when the % is unset.
        Total := Round((PoFreight + DeposcoFreight) * (1 + MarkupPct / 100), 0.01, '>');

        HdrRef.GetTable(SalesHeader);
        if not Opt.TrySetDecimal(HdrRef, 50330, 'Purchase Shipping Cost', PoFreight) then
            Error(TargetMissingErr, 50330, 'Purchase Shipping Cost');
        if not Opt.TrySetDecimal(HdrRef, 50014, 'ShippingCost', Total) then
            Error(TargetMissingErr, 50014, 'ShippingCost');
        HdrRef.Modify(true);
        HdrRef.SetTable(SalesHeader);

        // On a third-party order PK_BC_customization declines to manage the freight line at all:
        // both branches of RecreateShippingCostLines are gated on
        //     (ShippingCost <> 0) AND (LAX Shipping Payment Type <> ::"Third Party")
        // so it neither creates nor DELETES one, and AddPurchShipCost only fires when
        // ShippingCost = 0. Nothing at release will touch a line we write here, which is the only
        // reason this is safe — inbound vendor freight would otherwise never be billed on these
        // orders. Everything else keeps deferring to release exactly as before.
        if ThirdParty then
            WriteFreightLine(SalesHeader, Total, PoFreight);
    end;

    // Materialises the customer-facing freight line for the one case release refuses to handle.
    // 
    // Deliberately mirrors RecreateShippingCostLines field-for-field — same G/L account from
    // Sales & Receivables Setup, Unit Price = the marked-up charge, Unit Cost (LCY) = raw
    // inbound vendor freight, Quantity 1, Location/Responsibility Centre/Order Type off the
    // header — so an invoice cannot tell which code path produced it.
    // 
    // Only ever touches a line with Qty. Invoiced (Base) = 0, the same protection release uses:
    // an already-invoiced freight line is never rewritten. Existing lines are overwritten rather
    // than added to, so clicking the button twice recalculates instead of stacking.
    // 
    // If PK_BC_customization ever drops its Third Party gate, release would find this line,
    // delete it (uninvoiced) and rebuild it from the same ShippingCost and Purchase Shipping
    // Cost — same numbers, no duplicate. Whoever owns that app should know we lean on it.
    local procedure WriteFreightLine(SalesHeader: Record "Sales Header"; ChargeAmount: Decimal; RawInboundCost: Decimal)
    var
        SalesSetup: Record "Sales & Receivables Setup";
        SalesLine: Record "Sales Line";
        Opt: Codeunit "PK Optional Field";
        SetupRef: RecordRef;
        FreightAcc: Text;
        NextLineNo: Integer;
        FreightAccMissingErr: Label 'Sales & Receivables Setup field 50002 "Sales Shipping Cost G/L Acc." was not found or is blank. Is PK_BC18_TAB installed in this environment?';
    begin
        // The freight account is PK_BC18_TAB's (Sales & Receivables Setup 50002), not a standard
        // field, so it is read by number + name like everything else here rather than by taking a
        // dependency on that app. Blank or missing is an ERROR, not a silent skip: posting the
        // line to the wrong account would be worse than refusing.
        SalesSetup.Get();
        SetupRef.GetTable(SalesSetup);
        if not Opt.TryGetCode(SetupRef, 50002, 'Sales Shipping Cost G/L Acc.', FreightAcc) then
            Error(FreightAccMissingErr);
        if FreightAcc = '' then
            Error(FreightAccMissingErr);

        SalesLine.SetRange("Document Type", SalesHeader."Document Type");
        SalesLine.SetRange("Document No.", SalesHeader."No.");
        SalesLine.SetRange(Type, SalesLine.Type::"G/L Account");
        SalesLine.SetRange("No.", CopyStr(FreightAcc, 1, 20));
        SalesLine.SetRange("Qty. Invoiced (Base)", 0);
        if SalesLine.FindFirst() then begin
            SalesLine.Validate("Unit Cost (LCY)", RawInboundCost);
            SalesLine.Validate("Unit Price", ChargeAmount);
            SalesLine.Modify(true);
            exit;
        end;

        NextLineNo := 10000;
        SalesLine.Reset();
        SalesLine.SetRange("Document Type", SalesHeader."Document Type");
        SalesLine.SetRange("Document No.", SalesHeader."No.");
        if SalesLine.FindLast() then
            NextLineNo := SalesLine."Line No." + 10000;

        SalesLine.Init();
        SalesLine.Validate("Document Type", SalesHeader."Document Type");
        SalesLine.Validate("Document No.", SalesHeader."No.");
        SalesLine.Validate("Line No.", NextLineNo);
        SalesLine.Insert(true);
        SalesLine.Validate(Type, SalesLine.Type::"G/L Account");
        SalesLine.Validate("No.", CopyStr(FreightAcc, 1, 20));
        SalesLine.Validate("Location Code", SalesHeader."Location Code");
        SalesLine.Validate("Responsibility Center", SalesHeader."Responsibility Center");
        SalesLine.Validate(Quantity, 1);
        SalesLine.Validate("Unit Cost (LCY)", RawInboundCost);
        SalesLine.Validate("Unit Price", ChargeAmount);
        SalesLine.Modify(true);
    end;

    // Freight terms live on Lanham E-Ship's "LAX Shipping Payment Type", Sales Header field
    // 14000716. NOT 14000617 — that is the Enum OBJECT's id, which is what the symbol file shows
    // in the field's TypeDefinition. Using it meant FieldExist() was false, the guard silently
    // returned "not third party", and DISO211844 billed $19.40 of outbound Deposco freight it
    // should never have seen. Verified against the Lanham symbol reference: Sales Header 14000716,
    // Sales Line 14000722, Sales Shipment Header 14000716.
    // Read through PK Optional Field by number AND name: Lanham is being sunsetted, and this way
    // its removal degrades the check to "not third party" instead of breaking the button. It is
    // also not a new dependency — the Deposco customerOrder push already sources freightTermsType
    // and the eHub ship-via mapping from this same field.
    local procedure IsThirdPartyFreight(SalesHeader: Record "Sales Header"): Boolean
    var
        Opt: Codeunit "PK Optional Field";
        HdrRef: RecordRef;
        PaymentType: Text;
        PaymentTypeUnreadableErr: Label 'Could not read Sales Header field 14000716 "LAX Shipping Payment Type". Is Lanham E-Ship installed? Refusing to calculate: assuming NOT third party here would bill the customer for freight on their own carrier account.';
    begin
        // Deliberately an ERROR, not a silent exit(false). An unreadable payment type used to
        // degrade to "not third party", which is the dangerous direction — it bills outbound
        // freight that belongs on the customer's account. Refuse instead.
        HdrRef.GetTable(SalesHeader);
        if not Opt.TryGetOptionText(HdrRef, 14000716, 'LAX Shipping Payment Type', PaymentType) then
            Error(PaymentTypeUnreadableErr);
        exit(PaymentType.ToLower().Replace(' ', '') = 'thirdparty');
    end;

    // Vendor freight: identical source to the old button. POs created from a sales order are
    // stamped with the SO number in field 50010, which posting carries onto the posted purchase
    // invoice by field-number TransferFields; the freight itself is any invoice line on the
    // "Purch. Shipping Cost G/L Acc." from Purchases & Payables Setup, at Quantity * Unit Cost.
    local procedure LinkedPoFreight(OrderNo: Code[20]): Decimal
    var
        PurchInvHeader: Record "Purch. Inv. Header";
        PurchInvLine: Record "Purch. Inv. Line";
        PurchSetup: Record "Purchases & Payables Setup";
        Opt: Codeunit "PK Optional Field";
        InvRef: RecordRef;
        SetupRef: RecordRef;
        FreightAcc: Text;
        Freight: Decimal;
    begin
        PurchSetup.Get();
        SetupRef.GetTable(PurchSetup);
        if not Opt.TryGetCode(SetupRef, 50001, 'Purch. Shipping Cost G/L Acc.', FreightAcc) then
            exit(0);
        if FreightAcc = '' then
            exit(0);

        InvRef.Open(Database::"Purch. Inv. Header");
        if not Opt.TrySetRange(InvRef, 50010, 'SalesOrderNo', OrderNo) then begin
            InvRef.Close();
            exit(0);
        end;
        if InvRef.FindSet() then
            repeat
                InvRef.SetTable(PurchInvHeader);
                PurchInvLine.SetRange("Document No.", PurchInvHeader."No.");
                PurchInvLine.SetRange(Type, PurchInvLine.Type::"G/L Account");
                PurchInvLine.SetRange("No.", CopyStr(FreightAcc, 1, 20));
                if PurchInvLine.FindSet() then
                    repeat
                        Freight += PurchInvLine.Quantity * PurchInvLine."Unit Cost";
                    until PurchInvLine.Next() = 0;
            until InvRef.Next() = 0;
        InvRef.Close();
        exit(Freight);
    end;

    // "PK Deposco Order Freight Tot" is an ORDER-level total written ONCE, on whichever shipment
    // posts around the time Deposco reports the order Complete — the others hold 0 (see the
    // tableextension). Summing the column across the order's shipments is therefore the one
    // correct read, and the write-once guard in PK Ship Tracking Mgt means it can never double.
    local procedure DeposcoOrderFreight(OrderNo: Code[20]; var HasShipments: Boolean): Decimal
    var
        Shpt: Record "Sales Shipment Header";
        Freight: Decimal;
    begin
        Shpt.SetRange("Order No.", OrderNo);
        HasShipments := not Shpt.IsEmpty();
        Shpt.SetLoadFields("PK Deposco Order Freight Tot");
        if Shpt.FindSet() then
            repeat
                Freight += Shpt."PK Deposco Order Freight Tot";
            until Shpt.Next() = 0;
        exit(Freight);
    end;
}
