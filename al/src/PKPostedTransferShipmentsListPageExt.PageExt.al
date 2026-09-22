// Tracking No. + Carrier as columns on the Posted Transfer Shipments LIST, next to Shipping
// Agent Code, so a rep can scan for a transfer's tracking without opening each card.
pageextension 60238 "PK Posted Transfer Shpts Ext" extends "Posted Transfer Shipments"
{
    layout
    {
        addafter("Shipping Agent Code")
        {
            field("PK Deposco Tracking No."; Rec."PK Deposco Tracking No.")
            {
                ApplicationArea = All;
                Caption = 'Deposco Tracking No.';
                ToolTip = 'Tracking number(s) from the Deposco outbound shipment.';
            }
            field("PK Deposco Carrier"; Rec."PK Deposco Carrier")
            {
                ApplicationArea = All;
                Caption = 'Deposco Carrier';
                ToolTip = 'Carrier Deposco shipped with.';
            }
        }
    }
}
