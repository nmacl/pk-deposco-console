// The five Deposco fields already sit in a "Deposco" group on the Sales Order card, which means
// you only see a sync problem on an order you have already opened on purpose. On the list they
// are visible for every open order at once, sortable and filterable — filter Deposco Sync Status
// to Failed|Chronic and the problem orders are the whole page.
pageextension 60236 "PK Sales Order List Ext" extends "Sales Order List"
{
    layout
    {
        addlast(Control1)
        {
            field(PKSentToDeposco; Rec."PK Sent to Deposco")
            {
                ApplicationArea = All;
                Editable = false;
                ToolTip = 'Whether this order has ever been pushed to Deposco.';
            }
            field(PKSentToDeposcoAt; Rec."PK Sent to Deposco At")
            {
                ApplicationArea = All;
                Editable = false;
                Visible = false;
                ToolTip = 'When this order first reached Deposco.';
            }
            field(PKDeposcoSyncStatus; Rec."PK Deposco Sync Status")
            {
                ApplicationArea = All;
                Editable = false;
                StyleExpr = SyncStyle;
                ToolTip = 'Current sync health: OK, Failed (retrying), or Chronic (failing 2+ days — see the console).';
            }
            field(PKLastDeposcoError; Rec."PK Last Deposco Error")
            {
                ApplicationArea = All;
                Editable = false;
                ToolTip = 'BC''s own error text from the most recent sync attempt.';
            }
            field(PKDeposcoStatusAt; Rec."PK Deposco Status At")
            {
                ApplicationArea = All;
                Editable = false;
                ToolTip = 'When the sync status was last updated.';
            }
        }
    }

    var
        SyncStyle: Text;

    trigger OnAfterGetRecord()
    begin
        // Red for Chronic, amber for Failed, nothing otherwise — the eye finds the bad rows.
        case Rec."PK Deposco Sync Status" of
            Rec."PK Deposco Sync Status"::Chronic:
                SyncStyle := 'Unfavorable';
            Rec."PK Deposco Sync Status"::Failed:
                SyncStyle := 'Ambiguous';
            else
                SyncStyle := 'Standard';
        end;
    end;
}
