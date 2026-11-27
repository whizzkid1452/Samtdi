CREATE TABLE workspace_members (
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'member')),
    PRIMARY KEY (workspace_id, account_id)
);
CREATE INDEX workspace_members_by_account ON workspace_members(account_id, workspace_id);
