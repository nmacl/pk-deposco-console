// Applies a "PK Ship Tracking" buffer row onto its posted sales shipment (SLSS…).
//
// Why a codeunit rather than letting the API page modify the posted record directly: a page's
// Modify runs under the CALLER's rights, and the S2S API user's license does not grant Modify
// on TableData 110. The Permissions property below grants it to code running HERE — the same
// trick "PK Inv Adjustment Mgt" uses to post item journal lines.
codeunit 60222 "PK Ship Tracking Mgt"
{
    Permissions = tabledata "Sales Shipment Header" = RM,
                  tabledata "PK Ship Tracking" = RIMD;
    InherentPermissions = X;
    InherentEntitlements = X;

    /// Finds the posted shipment by "Shipment No." (exact) or, failing that, by
    /// "External Document No." — the SHIP-{soNo}-{epoch} ref sync-co.ts stamps just before
    /// posting, which is what makes the match exact when one order has several shipments.
    /// Stamps the outcome onto Buf. Throws on no-match so the POST surfaces the error.
    procedure Apply(var Buf: Record "PK Ship Tracking")
    var
        Shpt: Record "Sales Shipment Header";
        OptField: Codeunit "PK Optional Field";
        RecRef: RecordRef;
    begin
        if (Buf."Shipment No." = '') and (Buf."External Document No." = '') then
            Error('Supply either shipmentNo or externalDocumentNo.');

        if Buf."Shipment No." <> '' then begin
            if not Shpt.Get(Buf."Shipment No.") then
                Error('Posted sales shipment %1 not found.', Buf."Shipment No.");
        end else begin
            Shpt.SetRange("External Document No.", Buf."External Document No.");
            if not Shpt.FindLast() then
                Error('No posted sales shipment with External Document No. %1.', Buf."External Document No.");
            if Shpt.Count() > 1 then
                Error('External Document No. %1 matches %2 posted shipments — pass shipmentNo instead.',
                      Buf."External Document No.", Shpt.Count());
        end;

        if Buf."Clear Tracking" then begin
            ClearOn(Shpt);
            Buf.Applied := true;
            Buf."Applied To" := Shpt."No.";
            Buf."Applied At" := CurrentDateTime();
            exit;
        end;

        // Standard field first, so BC's own documents/emails/pages see the tracking number.
        // It takes the PRIMARY (first) number only — BC's Track Package action and the carrier
        // integrations expect a single value, and a comma-joined multi-parcel list breaks them.
        // The complete list stays in "PK Deposco Tracking No." (Text[250]).
        if Buf."Tracking No." <> '' then
            Shpt."Package Tracking No." := CopyStr(PrimaryTracking(Buf."Tracking No."), 1, MaxStrLen(Shpt."Package Tracking No."));

        Shpt."PK Deposco Shipment No." := Buf."Deposco Shipment No.";
        Shpt."PK Deposco Sales Order No." := Buf."Deposco Sales Order No.";
        Shpt."PK Deposco Tracking No." := Buf."Tracking No.";
        Shpt."PK Deposco Tracking URL" := Buf."Tracking URL";
        Shpt."PK Deposco Carrier" := Buf.Carrier;
        Shpt."PK Deposco Ship Via" := Buf."Ship Via";
        Shpt."PK Deposco Ship Method" := Buf."Ship Method";
        Shpt."PK Deposco Actual Ship Date" := Buf."Actual Ship Date";
        Shpt."PK Deposco Total Packages" := Buf."Total Packages";
        Shpt."PK Deposco Total Weight" := Buf."Total Weight";
        Shpt."PK Deposco Container LPN" := Buf."Container LPN";
        Shpt."PK Deposco Synced At" := CurrentDateTime();

        // Mirror the carrier into PK_BC18_TAB's PackageCarrier (50130) for anything already
        // reading it. By field number + NAME interlock — no dependency, and a silent no-op if
        // that app is absent OR if 50130 is a different field there. NOTE: PK_BC18_TAB is
        // published by UPG on PILOT and by Redefine on Production, so the name check is what
        // makes this safe to run in both.
        if Buf.Carrier <> '' then begin
            RecRef.GetTable(Shpt);
            if OptField.TrySetText(RecRef, 50130, 'PackageCarrier', Buf.Carrier) then
                RecRef.SetTable(Shpt);
        end;

        Shpt.Modify(true);

        Buf.Applied := true;
        Buf."Applied To" := Shpt."No.";
        Buf."Applied At" := CurrentDateTime();
        Buf."Error Message" := '';
    end;

    /// First element of a comma-separated tracking list (the whole string when there's one).
    local procedure PrimaryTracking(List: Text): Text
    var
        Comma: Integer;
    begin
        Comma := StrPos(List, ',');
        if Comma > 0 then
            exit(CopyStr(List, 1, Comma - 1));
        exit(List);
    end;

    /// Wipe every tracking field this codeunit ever writes, including the mirrored
    /// PackageCarrier, and stamp Synced At so the erase itself is auditable.
    local procedure ClearOn(var Shpt: Record "Sales Shipment Header")
    var
        OptField: Codeunit "PK Optional Field";
        RecRef: RecordRef;
    begin
        Shpt."Package Tracking No." := '';
        Shpt."PK Deposco Shipment No." := '';
        Shpt."PK Deposco Sales Order No." := '';
        Shpt."PK Deposco Tracking No." := '';
        Shpt."PK Deposco Tracking URL" := '';
        Shpt."PK Deposco Carrier" := '';
        Shpt."PK Deposco Ship Via" := '';
        Shpt."PK Deposco Ship Method" := '';
        Shpt."PK Deposco Actual Ship Date" := 0DT;
        Shpt."PK Deposco Total Packages" := 0;
        Shpt."PK Deposco Total Weight" := 0;
        Shpt."PK Deposco Container LPN" := '';
        Shpt."PK Deposco Synced At" := CurrentDateTime();
        RecRef.GetTable(Shpt);
        if OptField.TrySetText(RecRef, 50130, 'PackageCarrier', '') then
            RecRef.SetTable(Shpt);
        Shpt.Modify(true);
    end;

    /// Insert the audit row from here (not the page) so it runs with this codeunit's rights.
    procedure LogAndApply(var Buf: Record "PK Ship Tracking")
    begin
        Apply(Buf);
        Buf.Insert(true);
    end;
}
