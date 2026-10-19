// Deposco status on the Transfer Order card. Anchor is the base "General" group; UPG's
// "Transfer Order Ext" (50149) also uses addlast(General) — both append, no conflict.
pageextension 60239 "PK Transfer Order Ext" extends "Transfer Order"
{
    layout
    {
        addlast(General)
        {
            field("PK Deposco Status"; Rec."PK Deposco Status")
            {
                ApplicationArea = All;
                ToolTip = 'Current status of this transfer in Deposco (warehouse). Updated by the Deposco sync.';
            }
            field("PK Deposco Status At"; Rec."PK Deposco Status At")
            {
                ApplicationArea = All;
                ToolTip = 'When the Deposco status was last updated by the sync.';
            }
        }
    }
}
