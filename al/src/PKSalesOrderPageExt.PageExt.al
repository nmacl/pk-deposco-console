// Adds "Calculate Shipping Price" next to PK_BC_customization's "Calc Actual Shipping Cost".
// We cannot anchor to that action literally (it belongs to another extension we take no
// dependency on), but Promoted + Category8 lands it in the same promoted group on the ribbon.
pageextension 60232 "PK Sales Order Ext" extends "Sales Order"
{
    layout
    {
        addafter(General)
        {
            group(PKDeposcoStatus)
            {
                Caption = 'Deposco';
                field(PKSentToDeposco; Rec."PK Sent to Deposco")
                {
                    ApplicationArea = All;
                    Editable = false;
                    ToolTip = 'Whether this order has ever been pushed to Deposco. Once set, Westerly location changes and new item lines are guarded (see the Deposco Sent-Order Edit Log for anything let through).';
                }
                field(PKSentToDeposcoAt; Rec."PK Sent to Deposco At")
                {
                    ApplicationArea = All;
                    Editable = false;
                    ToolTip = 'When this order first reached Deposco.';
                }
                field(PKDeposcoSyncStatus; Rec."PK Deposco Sync Status")
                {
                    ApplicationArea = All;
                    Editable = false;
                    ToolTip = 'Current sync health: OK, Failed (retrying), or Chronic (failing 2+ days — see the console).';
                }
                field(PKLastDeposcoError; Rec."PK Last Deposco Error")
                {
                    ApplicationArea = All;
                    Editable = false;
                    ToolTip = 'BC''s own error text from the most recent sync attempt.';
                }
            }
        }
    }

    actions
    {
        addlast(processing)
        {
            action(PKDeposcoCalcShippingCost)
            {
                ApplicationArea = All;
                Caption = 'Calculate Shipping Price';
                Image = CreateForm;
                Promoted = true;
                PromotedCategory = Category8;
                ToolTip = 'Calculate the shipping cost to charge the customer from actual freight: vendor freight on the order''s posted purchase invoices plus the Deposco order freight total on its posted shipments, marked up by the Sales Shipping Markup % from Sales & Receivables Setup.';

                trigger OnAction()
                var
                    DeposcoShipCost: Codeunit "PK Deposco Ship Cost";
                begin
                    DeposcoShipCost.CalcDeposcoShippingCost(Rec);
                    CurrPage.Update(false);
                end;
            }
        }
    }
}
