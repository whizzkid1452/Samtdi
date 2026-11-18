CREATE TABLE account_identities (
    issuer text NOT NULL,
    subject text NOT NULL,
    account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    PRIMARY KEY (issuer, subject),
    UNIQUE (account_id, issuer)
);

INSERT INTO account_identities (issuer, subject, account_id)
SELECT issuer, subject, id FROM accounts;

CREATE INDEX identities_by_account ON account_identities(account_id);

CREATE TABLE workspaces (
    id uuid PRIMARY KEY,
    requested_name text NOT NULL,
    organization_id text UNIQUE,
    created_by uuid NOT NULL REFERENCES accounts,
    active boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE projects ADD COLUMN workspace_id uuid REFERENCES workspaces;
CREATE INDEX projects_by_workspace ON projects(workspace_id);
