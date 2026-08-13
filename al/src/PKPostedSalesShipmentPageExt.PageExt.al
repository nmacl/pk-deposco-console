// Surfaces the Deposco shipment detail on the Posted Sales Shipment card. A tableextension
// alone stores the data but shows nothing in the UI — this is what makes it visible to users.
//
// Placed after "Package Tracking No." in the Shipping group so the Deposco values sit next to
// the standard field they mirror.
pageextension 60231 "PK Posted Sales Shpt Ext" extends "Posted Sales Shipment"
{
    layout
    {
        addlast(General)
        {
            group(PKDeposco)
            {
                Caption = 'Deposco';

                field("PK Deposco Tracking No."; Rec."PK Deposco Tracking No.")
                {
                    ApplicationArea = All;
                    Caption = 'Tracking No.';
                    ToolTip = 'Tracking number(s) from the Deposco outbound shipment. Comma-separated when one BC shipment covers several parcels.';
                }
                field("PK Deposco Tracking URL"; Rec."PK Deposco Tracking URL")
                {
                    ApplicationArea = All;
                    Caption = 'Tracking URL';
                    ExtendedDatatype = URL;
                    ToolTip = 'Carrier tracking link for this shipment.';
                }
                field("PK Deposco Carrier"; Rec."PK Deposco Carrier")
                {
                    ApplicationArea = All;
                    Caption = 'Carrier';
                    ToolTip = 'Carrier reported by Deposco (shipVendor), e.g. FedEx or UPS.';
                }
                field("PK Deposco Ship Via"; Rec."PK Deposco Ship Via")
                {
                    ApplicationArea = All;
                    Caption = 'Ship Via';
                    ToolTip = 'Deposco ship-via service, e.g. eHub Fedex Express Saver.';
                }
                field("PK Deposco Shipment No."; Rec."PK Deposco Shipment No.")
                {
                    ApplicationArea = All;
                    Caption = 'Deposco Shipment No.';
                    ToolTip = 'Deposco outbound shipment this tracking came from.';
                }
                field("PK Deposco Sales Order No."; Rec."PK Deposco Sales Order No.")
                {
                    ApplicationArea = All;
                    Caption = 'Deposco Sales Order No.';
                    ToolTip = 'Deposco fulfillment order (e.g. SO12502) — not the BC sales order.';
                }
                field("PK Deposco Container LPN"; Rec."PK Deposco Container LPN")
                {
                    ApplicationArea = All;
                    Caption = 'Container LPN';
                    ToolTip = 'Deposco shipping container / license plate number.';
                }
                field("PK Deposco Total Packages"; Rec."PK Deposco Total Packages")
                {
                    ApplicationArea = All;
                    Caption = 'Total Packages';
                }
                field("PK Deposco Total Weight"; Rec."PK Deposco Total Weight")
                {
                    ApplicationArea = All;
                    Caption = 'Total Weight';
                }
                field("PK Deposco Actual Ship Date"; Rec."PK Deposco Actual Ship Date")
                {
                    ApplicationArea = All;
                    Caption = 'Actual Ship Date';
                }
                field("PK Deposco Order Freight Tot"; Rec."PK Deposco Order Freight Tot")
                {
                    ApplicationArea = All;
                    Caption = 'Order Freight Total';
                    ToolTip = 'Total Deposco freight for the WHOLE sales order, not just this shipment. Written once, when Deposco reports the order complete. If an order posted several shipments this value sits on one of them and the rest show blank — sum the column across the order rather than reading a single shipment as its own cost.';
                }
                field("PK Deposco Synced At"; Rec."PK Deposco Synced At")
                {
                    ApplicationArea = All;
                    Caption = 'Synced At';
                    ToolTip = 'When the middleware last wrote Deposco tracking to this shipment. Blank means never synced — distinct from synced with nothing to report.';
                }
            }
        }
    }
}
