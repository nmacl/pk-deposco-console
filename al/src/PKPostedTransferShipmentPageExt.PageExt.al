// "Deposco" group on the Posted Transfer Shipment card — laid out EXACTLY like the one on
// Posted Sales Shipment (pageextension 60231) so a rep sees the same thing on both documents.
// Tracking first, then link, carrier, service, and the Deposco references.
pageextension 60237 "PK Posted Transfer Shpt Ext" extends "Posted Transfer Shipment"
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
                    ToolTip = 'Tracking number(s) from the Deposco outbound shipment. Comma-separated when one BC transfer shipment covers several parcels.';
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
                    ToolTip = 'Carrier Deposco shipped with (e.g. FedEx, UPS).';
                }
                field("PK Deposco Ship Via"; Rec."PK Deposco Ship Via")
                {
                    ApplicationArea = All;
                    Caption = 'Ship Via';
                    ToolTip = 'Deposco ship-via / service level used for this shipment.';
                }
                field("PK Deposco Shipment No."; Rec."PK Deposco Shipment No.")
                {
                    ApplicationArea = All;
                    Caption = 'Deposco Shipment No.';
                    ToolTip = 'Deposco outbound shipment number(s) that make up this BC transfer shipment.';
                }
                field("PK Deposco Sales Order No."; Rec."PK Deposco Sales Order No.")
                {
                    ApplicationArea = All;
                    Caption = 'Deposco Sales Order No.';
                    ToolTip = 'Deposco fulfillment (sales) order that shipped this transfer.';
                }
                field("PK Deposco Container LPN"; Rec."PK Deposco Container LPN")
                {
                    ApplicationArea = All;
                    Caption = 'Container LPN';
                    ToolTip = 'License plate of the shipped container.';
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
                field("PK Deposco Synced At"; Rec."PK Deposco Synced At")
                {
                    ApplicationArea = All;
                    Caption = 'Synced At';
                    ToolTip = 'When the middleware last wrote Deposco tracking onto this shipment.';
                }
            }
        }
    }
}
