// Deposco receipt ref on the purchase order — the field that replaces the old abuse of
// "Vendor Invoice No.": the standard API's only posting action (receiveAndInvoice) validates
// that field even for receive-only posts, so the pull worker used to park an RCPT-… ref there,
// which then leaked into real AP invoices. Now the worker posts receive-only through
// "PK Purch Receive Mgt" (no Vendor Invoice No. validation at all) and the ref lives here.
//
// Field 60200 is deliberately the SAME NUMBER as on "Purch. Rcpt. Header" (60234): Purch.-Post
// creates the posted receipt via TransferFields, which copies matching field numbers — so every
// posted purchase receipt automatically carries the ref of the Deposco pull that created it,
// while this header field shows the LAST pull. Receipt history per order = Posted Purchase
// Receipts filtered to Order No., each tagged with its pull.
tableextension 60233 "PK Purch Header Ext" extends "Purchase Header"
{
    fields
    {
        field(60200; "PK Deposco Receipt Ref"; Code[35])
        {
            Caption = 'Deposco Receipt Ref';
            DataClassification = CustomerContent;
            Editable = false;
        }
    }
}
