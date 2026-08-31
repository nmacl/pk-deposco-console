// Audit trail for a Sales Line edit BC let through after a "you sure?" confirm — see
// "PK Sales Line Guard" for what writes it and why. InherentPermissions so any interactive
// user's session can insert here regardless of their own permission set: the writer is
// whoever happens to be editing the sales order, not a fixed, permissioned API caller (same
// reasoning "PK Inv Adjustment" and "PK Ship Tracking" use InherentPermissions for).
table 60216 "PK Sales Line Edit Log"
{
    Caption = 'PK Sales Line Edit Log';
    DataClassification = SystemMetadata;
    InherentPermissions = RIMDX;
    InherentEntitlements = RIMDX;

    fields
    {
        field(1; "Entry No."; Integer)
        {
            Caption = 'Entry No.';
            AutoIncrement = true;
        }
        field(2; "Document No."; Code[20])
        {
            Caption = 'Document No.';
        }
        field(3; "Line No."; Integer)
        {
            Caption = 'Line No.';
        }
        field(4; "Changed At"; DateTime)
        {
            Caption = 'Changed At';
        }
        field(5; "Changed By"; Code[50])
        {
            Caption = 'Changed By';
        }
        field(6; "Change Type"; Text[50])
        {
            Caption = 'Change Type';
        }
        field(7; "Field Name"; Text[50])
        {
            Caption = 'Field Name';
        }
        field(8; "Old Value"; Text[250])
        {
            Caption = 'Old Value';
        }
        field(9; "New Value"; Text[250])
        {
            Caption = 'New Value';
        }
    }

    keys
    {
        key(PK; "Entry No.")
        {
            Clustered = true;
        }
        key(ByDoc; "Document No.", "Line No.")
        {
        }
    }
}
