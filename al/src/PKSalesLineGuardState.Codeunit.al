// Session memory for the sent-order line-edit guard: which orders the user has already answered
// "Yes to all" for. SingleInstance = lives for the user's session and dies with it, so the
// override never outlasts the sitting in which it was given and is never shared between users.
codeunit 60229 "PK Sales Line Guard State"
{
    SingleInstance = true;

    var
        ApprovedDocs: List of [Code[20]];

    procedure Approve(DocumentNo: Code[20])
    begin
        if not ApprovedDocs.Contains(DocumentNo) then
            ApprovedDocs.Add(DocumentNo);
    end;

    procedure IsApproved(DocumentNo: Code[20]): Boolean
    begin
        exit(ApprovedDocs.Contains(DocumentNo));
    end;
}
