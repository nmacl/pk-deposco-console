// Deposco send + sync-health tracking on the sales order header. Read by ops directly on the
// Sales Order page (see "PK Sales Order Ext" pageextension); written by the Node middleware
// through bmiSalesOrders' markSentToDeposco/setSyncStatus actions (see "PK Sales Order API").
//
// Two lifecycles, deliberately kept separate rather than one field: "Sent" answers "did this
// order ever leave BC for Deposco" — set once, on the first successful push, and never reset.
// "Sync Status" answers "is it healthy right now" — updated on every subsequent sync attempt,
// success or fail. Conflating them would make a transient post-send failure look like the order
// was never sent at all.
//
// Field numbers start at 60300, NOT 60200: this app already has multiple table extensions
// numbering their own fields from 60200 (PKSalesShipmentExt on Sales Shipment Header,
// PKPurchHeaderExt/PKPurchRcptHeaderExt on Purchase Header/Purch. Rcpt. Header). Field IDs in
// this app are NOT scoped per target table — BC's schema sync tracks them across the whole app,
// and reusing 60200 here for an unrelated field/type on Sales Header broke deployment ("the
// following fields must have the same type") until this range was moved clear of every existing
// tableextension in al/src/*.TableExt.al. Check `grep -n "field(" al/src/*.TableExt.al` before
// ever picking a table-extension field number in this app.
tableextension 60235 "PK Sales Header Ext" extends "Sales Header"
{
    fields
    {
        field(60300; "PK Sent to Deposco"; Boolean)
        {
            Caption = 'Sent to Deposco';
            DataClassification = SystemMetadata;
        }
        field(60301; "PK Sent to Deposco At"; DateTime)
        {
            Caption = 'Sent to Deposco At';
            DataClassification = SystemMetadata;
        }
        field(60302; "PK Deposco Sync Status"; Option)
        {
            Caption = 'Deposco Sync Status';
            OptionMembers = " ",OK,Failed,Chronic;
            OptionCaption = ' ,OK,Failed,Chronic';
            DataClassification = SystemMetadata;
        }
        field(60303; "PK Last Deposco Error"; Text[250])
        {
            Caption = 'Last Deposco Error';
            DataClassification = SystemMetadata;
        }
        field(60304; "PK Deposco Status At"; DateTime)
        {
            Caption = 'Deposco Status At';
            DataClassification = SystemMetadata;
        }
    }
}
