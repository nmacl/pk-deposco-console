// Adds "Calculate Shipping Price" next to PK_BC_customization's "Calc Actual Shipping Cost".
// We cannot anchor to that action literally (it belongs to another extension we take no
// dependency on), but Promoted + Category8 lands it in the same promoted group on the ribbon.
pageextension 60232 "PK Sales Order Ext" extends "Sales Order"
{
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
