// Applies a "PK Transfer Ship Tracking" buffer row onto its posted transfer shipment.
//
// Why a codeunit rather than letting the API page modify the posted record directly: a page's
// Modify runs under the CALLER's rights, and the S2S API user's license does not grant Modify
// on posted document tables. The Permissions property below grants it to code running HERE —
// the same trick "PK Ship Tracking Mgt" (60222) uses for sales shipments.
codeunit 60230 "PK Transfer Ship Tracking Mgt"
{
    Permissions = tabledata "Transfer Shipment Header" = RM,
                  tabledata "PK Transfer Ship Tracking" = RIMD;
    InherentPermissions = X;
    InherentEntitlements = X;

    /// Finds the posted transfer shipment by "Shipment No." (exact) or, failing that, by
    /// "Transfer Order No." — unambiguous only when the order posted a single shipment; the
    /// middleware passes the exact posted document number whenever it has one (the postShipment
    /// action returns it). Stamps the outcome onto Buf. Throws on no-match so the POST surfaces
    /// the error.
    procedure Apply(var Buf: Record "PK Transfer Ship Tracking")
    var
        Shpt: Record "Transfer Shipment Header";
    begin
        if (Buf."Shipment No." = '') and (Buf."Transfer Order No." = '') then
            Error('Supply either shipmentNo or transferOrderNo.');

        if Buf."Shipment No." <> '' then begin
            if not Shpt.Get(Buf."Shipment No.") then
                Error('Posted transfer shipment %1 not found.', Buf."Shipment No.");
        end else begin
            Shpt.SetRange("Transfer Order No.", Buf."Transfer Order No.");
            if not Shpt.FindLast() then
                Error('No posted transfer shipment for transfer order %1.', Buf."Transfer Order No.");
            if Shpt.Count() > 1 then
                Error('Transfer order %1 has %2 posted shipments — pass shipmentNo instead.',
                      Buf."Transfer Order No.", Shpt.Count());
        end;

        if Buf."Clear Tracking" then begin
            ClearOn(Shpt);
            Buf.Applied := true;
            Buf."Applied To" := Shpt."No.";
            Buf."Applied At" := CurrentDateTime();
            exit;
        end;

        // BLANK MEANS "LEAVE ALONE", not "erase" — a partial payload must never wipe a good
        // tracking number. Wiping is explicit via "Clear Tracking" above.
        if Buf."Deposco Shipment No." <> '' then
            Shpt."PK Deposco Shipment No." := Buf."Deposco Shipment No.";
        if Buf."Deposco Sales Order No." <> '' then
            Shpt."PK Deposco Sales Order No." := Buf."Deposco Sales Order No.";
        if Buf."Tracking No." <> '' then
            Shpt."PK Deposco Tracking No." := Buf."Tracking No.";
        if Buf."Tracking URL" <> '' then
            Shpt."PK Deposco Tracking URL" := Buf."Tracking URL";
        if Buf.Carrier <> '' then
            Shpt."PK Deposco Carrier" := Buf.Carrier;
        if Buf."Ship Via" <> '' then
            Shpt."PK Deposco Ship Via" := Buf."Ship Via";
        if Buf."Ship Method" <> '' then
            Shpt."PK Deposco Ship Method" := Buf."Ship Method";
        if Buf."Actual Ship Date" <> 0DT then
            Shpt."PK Deposco Actual Ship Date" := Buf."Actual Ship Date";
        if Buf."Total Packages" <> 0 then
            Shpt."PK Deposco Total Packages" := Buf."Total Packages";
        if Buf."Total Weight" <> 0 then
            Shpt."PK Deposco Total Weight" := Buf."Total Weight";
        if Buf."Container LPN" <> '' then
            Shpt."PK Deposco Container LPN" := Buf."Container LPN";
        Shpt."PK Deposco Synced At" := CurrentDateTime();
        Shpt.Modify(true);

        Buf.Applied := true;
        Buf."Applied To" := Shpt."No.";
        Buf."Applied At" := CurrentDateTime();
        Buf."Error Message" := '';
    end;

    /// Wipe every tracking field this codeunit ever writes and stamp Synced At so the erase
    /// itself is auditable.
    local procedure ClearOn(var Shpt: Record "Transfer Shipment Header")
    begin
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
        Shpt.Modify(true);
    end;

    /// Insert the audit row from here (not the page) so it runs with this codeunit's rights.
    procedure LogAndApply(var Buf: Record "PK Transfer Ship Tracking")
    begin
        Apply(Buf);
        Buf.Insert(true);
    end;
}
