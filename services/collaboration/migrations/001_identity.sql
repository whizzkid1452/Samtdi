CREATE TABLE accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer text NOT NULL,
    subject text NOT NULL,
    email text NOT NULL UNIQUE,
    operator boolean NOT NULL DEFAULT false,
    UNIQUE (issuer, subject)
);

CREATE UNIQUE INDEX only_first_operator ON accounts (operator) WHERE operator;

CREATE TABLE projects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE project_role AS ENUM ('reviewer', 'editor', 'owner');

CREATE TABLE memberships (
    project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    role project_role NOT NULL,
    PRIMARY KEY (project_id, account_id)
);

CREATE INDEX memberships_by_account ON memberships (account_id, project_id);

CREATE TABLE invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash bytea NOT NULL UNIQUE,
    project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
    email text NOT NULL,
    role project_role NOT NULL,
    expires_at timestamptz NOT NULL,
    accepted_by uuid REFERENCES accounts,
    revoked_at timestamptz
);

CREATE TABLE login_attempts (
    state_hash bytea PRIMARY KEY,
    browser_hash bytea NOT NULL,
    nonce text NOT NULL,
    verifier text NOT NULL,
    invite_hash bytea,
    native_redirect text,
    native_state text,
    native_challenge text,
    expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);

CREATE TABLE native_codes (
    code_hash bytea PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    redirect text NOT NULL,
    challenge text NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT now() + interval '1 minute'
);

CREATE TABLE sessions (
    token_hash bytea PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('web', 'native')),
    expires_at timestamptz NOT NULL
);
