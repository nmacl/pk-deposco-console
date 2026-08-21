// Shows which Deposco pull created this posted receipt (stamped at posting via TransferFields,
// see PKPurchRcptHeaderExt).
pageextension 60234 "PK Posted Purch Rcpt Ext" extends "Posted Purchase Receipt"
{
    layout
    {
        addlast(General)
        {
            field("PK Deposco Receipt Ref"; Rec."PK Deposco Receipt Ref")
            {
                ApplicationArea = All;
                Editable = false;
                ToolTip = 'Reference of the Deposco receipt pull that posted this receipt.';
            }
        }
    }
}
