// Request/audit row backing the one-off iPayment-fix WRITE API (see PKIPaymentFixMgt).
// One POST = one operation (LIST / DELETE / RENAME); the response row carries the outcome
// in "Match Count" + Result, and the rows left behind are the audit trail of what was done.
//
// Context (2026-08-19): customer card CTDI003931 "Efootwear" was mis-renamed to "S".
// iSolutions' iPayments extension holds a row in its Customer Setup table (70437044) that
// blocks renaming it back; their prescribed fix is "remove that row, then rename". This
// table + its page/codeunit do exactly that over the API instead of a manual config package.
table 60214 "PK IPayment Fix"
{
    Caption = 'PK IPayment Fix';
    DataClassification = CustomerContent;
    // Same rationale as "PK Inv Adjustment": the limited S2S API user inserts request rows
    // here without the permission set needing write access.
    InherentPermissions = RIMDX;
    InherentEntitlements = RIMDX;

    fields
    {
        field(1; "Entry No."; Integer) { Caption = 'Entry No.'; AutoIncrement = true; }
        // LIST | DELETE | RENAME (see PKIPaymentFixMgt.Run)
        field(10; "Fix Action"; Code[10]) { Caption = 'Fix Action'; }
        field(11; "Customer No."; Code[20]) { Caption = 'Customer No.'; }
        // RENAME only: the number the customer card should get.
        field(12; "New No."; Code[20]) { Caption = 'New No.'; }
        field(20; "Match Count"; Integer) { Caption = 'Match Count'; Editable = false; }
        // LIST/DELETE: JSON of the matched/deleted 70437044 rows (the DELETE response doubles
        // as the backup copy iSolutions' manual procedure gets from the config-package export).
        field(21; Result; Text[2048]) { Caption = 'Result'; Editable = false; }
    }

    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
    }
}
