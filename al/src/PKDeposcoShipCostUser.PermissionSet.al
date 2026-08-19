/// Client-side companion to "PK Deposco Read API" (60200).
///
/// 60200 is written for the Entra S2S caller and grants a lot it needs and a human does not —
/// item journal RIMD, the iPayment fix surface, the API pages. The Calculate Shipping Price
/// button is clicked by warehouse and customer-service users in the client, so they need
/// Execute on the codeunit and nothing else.
///
/// Why a permission set rather than InherentPermissions on the codeunit: inherent permissions
/// elevate what the code may do once it is RUNNING. Starting it still requires the caller to
/// hold Execute, which is a permission set. InherentEntitlements on 60225 clears the licence
/// check; this clears the permission check behind it.
///
/// The table access the calculation needs is declared on codeunit 60225 itself, so it is not
/// repeated here — that is the point of putting it there.
permissionset 60201 "PK Deposco Freight"
{
    Assignable = true;
    Caption = 'PK Deposco Calculate Shipping Price';
    Permissions =
        codeunit "PK Deposco Ship Cost" = X,
        codeunit "PK Optional Field" = X;
}
