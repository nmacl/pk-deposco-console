// Surfaces the Deposco receipt ref on the Purchase Order card (last pull posted against the
// order). The full receipt history lives on Posted Purchase Receipts — see PKPurchRcptPageExt.
pageextension 60233 "PK Purchase Order Ext" extends "Purchase Order"
{
    layout
    {
        addlast(General)
        {
            field("PK Deposco Receipt Ref"; Rec."PK Deposco Receipt Ref")
            {
                ApplicationArea = All;
                Editable = false;
                ToolTip = 'Reference of the last Deposco receipt pull posted against this order. Each Posted Purchase Receipt carries the ref of the pull that created it.';
            }
        }
    }
}
