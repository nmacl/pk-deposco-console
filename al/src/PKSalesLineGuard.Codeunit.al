// Guards Sales Lines on an order already sent to Deposco. Two triggers, both scoped to
// Type = Item only — Charge (Item)/G/L Account lines (freight billing via "Calculate Shipping
// Price", credit/discount corrections, comment lines) carry no fulfillment risk and Finance
// needs to keep touching those completely freely:
//   1. Changing Location Code to or from WESTERLY — the direct cause of the Location Code
//      mismatch BC throws on postShipment when Deposco has already reserved/shipped against
//      the original location.
//   2. Adding a brand-new item line — it never went through the original push, so Deposco has
//      no idea it exists.
//
// Neither is a hard stop. BC shows a confirm so a legitimate edit (a correction, a
// cancellation) can proceed — but every "yes" is logged to "PK Sales Line Edit Log" so it's
// visible who overrode the warning and when, instead of a popup only the editor ever saw.
codeunit 60228 "PK Sales Line Guard"
{
    Permissions = tabledata "PK Sales Line Edit Log" = RIMD;

    [EventSubscriber(ObjectType::Table, Database::"Sales Line", 'OnBeforeValidateEvent', 'Location Code', false, false)]
    local procedure OnBeforeValidateLocationCode(var Rec: Record "Sales Line"; var xRec: Record "Sales Line")
    var
        SalesHeader: Record "Sales Header";
    begin
        if not GuiAllowed() then
            exit;
        if Rec."Document Type" <> Rec."Document Type"::Order then
            exit;
        if Rec.Type <> Rec.Type::Item then
            exit;
        if Rec."Location Code" = xRec."Location Code" then
            exit;
        if (xRec."Location Code" <> 'WESTERLY') and (Rec."Location Code" <> 'WESTERLY') then
            exit;
        if not SalesHeader.Get(Rec."Document Type", Rec."Document No.") then
            exit;
        if not SalesHeader."PK Sent to Deposco" then
            exit;

        if not Confirm('Sales order %1 was already sent to Deposco. Changing the Westerly location on line %2 can desync the shipment.\Please submit a Wrike ticket before making this change.\Continue anyway?', false, Rec."Document No.", Rec."Line No.") then
            Error('Location Code change cancelled.');

        LogEdit(Rec, 'Location Code changed', 'Location Code', xRec."Location Code", Rec."Location Code");
    end;

    [EventSubscriber(ObjectType::Table, Database::"Sales Line", 'OnBeforeInsertEvent', '', false, false)]
    local procedure OnBeforeInsertSalesLine(var Rec: Record "Sales Line")
    var
        SalesHeader: Record "Sales Header";
    begin
        if not GuiAllowed() then
            exit;
        if Rec."Document Type" <> Rec."Document Type"::Order then
            exit;
        if Rec.Type <> Rec.Type::Item then
            exit;
        if not SalesHeader.Get(Rec."Document Type", Rec."Document No.") then
            exit;
        if not SalesHeader."PK Sent to Deposco" then
            exit;

        if not Confirm('Sales order %1 was already sent to Deposco. A new item line added now may never reach the shipment.\Please submit a Wrike ticket before making this change.\Continue anyway?', false, Rec."Document No.") then
            Error('New line cancelled.');

        LogEdit(Rec, 'Item line added', 'Item No.', '', Rec."No.");
    end;

    local procedure LogEdit(var SalesLine: Record "Sales Line"; ChangeType: Text[50]; FieldName: Text[50]; OldValue: Text[250]; NewValue: Text[250])
    var
        Log: Record "PK Sales Line Edit Log";
    begin
        Log.Init();
        Log."Document No." := SalesLine."Document No.";
        Log."Line No." := SalesLine."Line No.";
        Log."Changed At" := CurrentDateTime();
        Log."Changed By" := CopyStr(UserId(), 1, MaxStrLen(Log."Changed By"));
        Log."Change Type" := ChangeType;
        Log."Field Name" := FieldName;
        Log."Old Value" := OldValue;
        Log."New Value" := NewValue;
        Log.Insert(true);
    end;
}
