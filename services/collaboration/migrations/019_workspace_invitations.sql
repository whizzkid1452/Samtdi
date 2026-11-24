CREATE TABLE workspace_invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    accepted_by uuid REFERENCES accounts,
    revoked_at timestamptz
);
CREATE INDEX workspace_invitations_by_workspace ON workspace_invitations(workspace_id,created_at DESC,id);
