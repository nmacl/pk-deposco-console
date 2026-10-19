// Deposco status column on the Transfer Orders list. Anchor "Control1" is the base repeater;
// UPG's "Transfer Orders Ext" (50150) also uses addlast(Control1) — both append, no conflict.
pageextension 60240 "PK Transfer Orders Ext" extends "Transfer Orders"
{
    layout
    {
        addlast(Control1)
        {
            field("PK Deposco Status"; Rec."PK Deposco Status")
            {
                ApplicationArea = All;
                ToolTip = 'Current status of this transfer in Deposco (warehouse). Updated by the Deposco sync.';
            }
        }
    }
}
