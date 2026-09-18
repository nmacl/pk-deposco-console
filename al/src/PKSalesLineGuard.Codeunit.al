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
        if IsExemptUser() then
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

        // One answer can cover the whole order. Changing every line's location on a multi-line
        // order meant one popup per line (Jordan, 2026-09-15); "Yes to all" remembers the order for
        // the rest of this user's session, and every line changed under it is still logged.
        if GuardState.IsApproved(Rec."Document No.") then begin
            LogEdit(Rec, 'Location Code changed (yes to all)', 'Location Code', xRec."Location Code", Rec."Location Code");
            exit;
        end;
        case StrMenu(ChoicesTxt, 3, StrSubstNo(LocationQst, Rec."Document No.", Rec."Line No.")) of
            1:
                LogEdit(Rec, 'Location Code changed', 'Location Code', xRec."Location Code", Rec."Location Code");
            2:
                begin
                    GuardState.Approve(Rec."Document No.");
                    LogEdit(Rec, 'Location Code changed (yes to all)', 'Location Code', xRec."Location Code", Rec."Location Code");
                end;
            else
                Error('Location Code change cancelled.');
        end;
    end;

    [EventSubscriber(ObjectType::Table, Database::"Sales Line", 'OnBeforeInsertEvent', '', false, false)]
    local procedure OnBeforeInsertSalesLine(var Rec: Record "Sales Line")
    var
        SalesHeader: Record "Sales Header";
    begin
        if not GuiAllowed() then
            exit;
        if IsExemptUser() then
            exit;
        if Rec."Document Type" <> Rec."Document Type"::Order then
            exit;
        if Rec.Type <> Rec.Type::Item then
            exit;
        if not SalesHeader.Get(Rec."Document Type", Rec."Document No.") then
            exit;
        if not SalesHeader."PK Sent to Deposco" then
            exit;

        // Same session memory as the location guard: one "Yes to all" covers every further line
        // on this order. Needed because a posting-date change on a sent order re-inserts its
        // Westerly item lines (Jordan, DISO215972, 2026-09-18), and each re-insert asked again.
        if GuardState.IsApproved(Rec."Document No.") then begin
            LogEdit(Rec, 'Item line added (yes to all)', 'Item No.', '', Rec."No.");
            exit;
        end;
        case StrMenu(ChoicesTxt, 3, StrSubstNo(NewLineQst, Rec."Document No.")) of
            1:
                LogEdit(Rec, 'Item line added', 'Item No.', '', Rec."No.");
            2:
                begin
                    GuardState.Approve(Rec."Document No.");
                    LogEdit(Rec, 'Item line added (yes to all)', 'Item No.', '', Rec."No.");
                end;
            else
                Error('New line cancelled.');
        end;
    end;

    // Finance — posting dates, invoicing corrections, and the like on a sent order's lines, never
    // the warehouse/location concerns this guard exists for. Exempted entirely, not just confirmed
    // through: no popup, no log entry, nothing. Update this list directly when Finance's roster
    // changes; there is no BC setup screen backing it.
    local procedure IsExemptUser(): Boolean
    begin
        case UpperCase(UserId()) of
            'ACCRECV', 'CBURNS', 'CKELLY', 'JOY', 'JPOWELL', 'LRICHARDSON', 'PETMC', 'SMAYBEN', 'SSAURO', 'STARTY', 'VSOLOMON', 'DCOOGAN':
                exit(true);
            else
                exit(false);
        end;
    end;

    var
        GuardState: Codeunit "PK Sales Line Guard State";
        ChoicesTxt: Label 'Yes, this line,Yes to all lines on this order,No';
        NewLineQst: Label 'Sales order %1 was already sent to Deposco. A new item line added now may never reach the shipment.\Please submit a Wrike ticket before making this change.\Continue anyway?', Comment = '%1 = order no.';
        LocationQst: Label 'Sales order %1 was already sent to Deposco. Changing the Westerly location on line %2 can desync the shipment.\Please submit a Wrike ticket before making this change.\Continue anyway?', Comment = '%1 = order no., %2 = line no.';

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
