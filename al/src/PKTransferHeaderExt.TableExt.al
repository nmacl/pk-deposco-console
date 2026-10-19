// Deposco "Current Status" on OPEN transfer orders (Transfer Header, 5740), asked for by ops
// 2026-10-19 so the warehouse state (New / Picking / Back Ordered / Ship Complete …) is visible on
// the Transfer Order card and the Transfer Orders list without opening Deposco.
//
// Written ONLY by the middleware through the setDeposcoStatus bound action on
// "PK Transfer Order Header API" (60206). Never editable from the UI.
//
// Field numbers start at 60500: field IDs in this app are tracked across the WHOLE app by BC's
// schema sync (see PKSalesHeaderExt.TableExt.al), so this band is kept clear of every other
// tableextension in al/src. UPG's "Transfer Header Ext" (50084) uses 50000–50250; Lanham uses
// 14097xxx. No overlap.
tableextension 60239 "PK Transfer Header Ext" extends "Transfer Header"
{
    fields
    {
        field(60500; "PK Deposco Status"; Text[30])
        {
            Caption = 'Deposco Status';
            DataClassification = CustomerContent;
            Editable = false;
        }
        field(60501; "PK Deposco Status At"; DateTime)
        {
            Caption = 'Deposco Status At';
            DataClassification = CustomerContent;
            Editable = false;
        }
    }
}
