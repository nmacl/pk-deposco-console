// Posted-side twin of "PK Purch Header Ext" (60233). Same field NUMBER on purpose:
// Purch.-Post's TransferFields copies it from the order header at posting time, permanently
// tagging each posted purchase receipt with the Deposco pull that produced it. No code writes
// this table directly.
tableextension 60234 "PK Purch Rcpt Header Ext" extends "Purch. Rcpt. Header"
{
    fields
    {
        field(60200; "PK Deposco Receipt Ref"; Code[35])
        {
            Caption = 'Deposco Receipt Ref';
            DataClassification = CustomerContent;
            Editable = false;
        }
    }
}
