// Stamps the Deposco status onto an open Transfer Header. Elevated Modify lives here so the
// read-only API page (and the read-only permission set) never grant UI-level write.
codeunit 60232 "PK Transfer Deposco Status Mgt"
{
    Permissions = tabledata "Transfer Header" = RM;

    procedure Apply(var TransferHeader: Record "Transfer Header"; NewStatus: Text)
    begin
        if TransferHeader."PK Deposco Status" = CopyStr(NewStatus, 1, MaxStrLen(TransferHeader."PK Deposco Status")) then
            exit;
        TransferHeader."PK Deposco Status" := CopyStr(NewStatus, 1, MaxStrLen(TransferHeader."PK Deposco Status"));
        TransferHeader."PK Deposco Status At" := CurrentDateTime();
        TransferHeader.Modify(false);
    end;
}
