// Manager-facing view of "PK Sales Line Edit Log" — every time someone clicked through the
// Westerly/new-line warning on an order already sent to Deposco. Read-only; the log is
// write-once from "PK Sales Line Guard".
page 60216 "PK Sales Line Edit Log List"
{
    PageType = List;
    ApplicationArea = All;
    UsageCategory = Lists;
    Caption = 'Deposco Sent-Order Edit Log';
    SourceTable = "PK Sales Line Edit Log";
    Editable = false;
    InsertAllowed = false;
    ModifyAllowed = false;
    DeleteAllowed = false;
    SourceTableView = sorting("Entry No.") order(descending);

    layout
    {
        area(Content)
        {
            repeater(Group)
            {
                field("Changed At"; Rec."Changed At") { ApplicationArea = All; }
                field("Changed By"; Rec."Changed By") { ApplicationArea = All; }
                field("Document No."; Rec."Document No.") { ApplicationArea = All; }
                field("Line No."; Rec."Line No.") { ApplicationArea = All; }
                field("Change Type"; Rec."Change Type") { ApplicationArea = All; }
                field("Field Name"; Rec."Field Name") { ApplicationArea = All; }
                field("Old Value"; Rec."Old Value") { ApplicationArea = All; }
                field("New Value"; Rec."New Value") { ApplicationArea = All; }
            }
        }
    }
}
