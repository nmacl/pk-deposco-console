// Request/audit row backing the purchase receive-only WRITE API. One POST = one receipt
// posting: the pull worker sends the order, its RCPT-… pull ref, and "lineNo:qty" pairs;
// the API page posts a receive-only purchase receipt on insert and writes the outcome
// (Posted Receipt No. / Lines Received / Already Posted) back onto the row. Rows left
// behind are the audit trail — same contract as "PK Inv Adjustment".
table 60215 "PK Purch Receipt"
{
    Caption = 'PK Purch Receipt';
    DataClassification = CustomerContent;
    // Same rationale as the other buffer tables: the limited S2S API user inserts request
    // rows without the permission set needing write access.
    InherentPermissions = RIMDX;
    InherentEntitlements = RIMDX;

    fields
    {
        field(1; "Entry No."; Integer) { Caption = 'Entry No.'; AutoIncrement = true; }
        field(10; "Order No."; Code[20]) { Caption = 'Order No.'; }
        // The worker's pull ref (RCPT-{poNo}-{epoch}) — the idempotency key: a retried POST
        // with a ref that already posted returns the existing receipt instead of double-receiving.
        field(11; "Deposco Receipt Ref"; Code[35]) { Caption = 'Deposco Receipt Ref'; }
        // "lineNo:qty" pairs, comma-separated (e.g. "10000:5,30000:2"). Lines not named
        // receive 0 this posting.
        field(12; Lines; Text[2048]) { Caption = 'Lines'; }
        // Posting date for the receipt = the day Deposco actually received the goods (the
        // worker sends the Deposco receipt's createdDate). 0D = leave the order header's own
        // Posting Date alone (the pre-2.18 behaviour, which stamped the ORDER date on receipts
        // posted weeks later — the "received Aug 1st" item-ledger complaint).
        field(13; "Posting Date"; Date) { Caption = 'Posting Date'; }
        field(20; "Posted Receipt No."; Code[20]) { Caption = 'Posted Receipt No.'; Editable = false; }
        field(21; "Lines Received"; Integer) { Caption = 'Lines Received'; Editable = false; }
        field(22; "Already Posted"; Boolean) { Caption = 'Already Posted'; Editable = false; }
    }

    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
        key(Ref; "Deposco Receipt Ref") { }
    }
}
