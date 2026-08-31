// Deposco send + sync-health tracking on the sales order header. Read by ops directly on the
// Sales Order page (see "PK Sales Order Ext" pageextension); written by the Node middleware
// through bmiSalesOrders' markSentToDeposco/setSyncStatus actions (see "PK Sales Order API").
//
// Two lifecycles, deliberately kept separate rather than one field: "Sent" answers "did this
// order ever leave BC for Deposco" — set once, on the first successful push, and never reset.
// "Sync Status" answers "is it healthy right now" — updated on every subsequent sync attempt,
// success or fail. Conflating them would make a transient post-send failure look like the order
// was never sent at all.
tableextension 60235 "PK Sales Header Ext" extends "Sales Header"
{
    fields
    {
        field(60200; "PK Sent to Deposco"; Boolean)
        {
            Caption = 'Sent to Deposco';
            DataClassification = SystemMetadata;
        }
        field(60201; "PK Sent to Deposco At"; DateTime)
        {
            Caption = 'Sent to Deposco At';
            DataClassification = SystemMetadata;
        }
        field(60202; "PK Deposco Sync Status"; Option)
        {
            Caption = 'Deposco Sync Status';
            OptionMembers = " ",OK,Failed,Chronic;
            OptionCaption = ' ,OK,Failed,Chronic';
            DataClassification = SystemMetadata;
        }
        field(60203; "PK Last Deposco Error"; Text[250])
        {
            Caption = 'Last Deposco Error';
            DataClassification = SystemMetadata;
        }
        field(60204; "PK Deposco Status At"; DateTime)
        {
            Caption = 'Deposco Status At';
            DataClassification = SystemMetadata;
        }
    }
}
