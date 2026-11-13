CREATE TABLE reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES accounts,
    title text NOT NULL,
    source_ref text NOT NULL,
    base_oid text NOT NULL CHECK (base_oid ~ '^[0-9a-f]{40}$'),
    head_oid text NOT NULL CHECK (head_oid ~ '^[0-9a-f]{40}$'),
    validation text NOT NULL DEFAULT 'unchecked' CHECK (validation IN ('unchecked', 'clean', 'conflict')),
    pending_oid text CHECK (pending_oid ~ '^[0-9a-f]{40}$'),
    merged_oid text CHECK (merged_oid ~ '^[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, source_ref, base_oid, head_oid)
);

CREATE TABLE review_comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id uuid NOT NULL REFERENCES reviews ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES accounts,
    commit_oid text NOT NULL CHECK (commit_oid ~ '^[0-9a-f]{40}$'),
    body text NOT NULL,
    position_ticks bigint CHECK (position_ticks >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX review_comments_by_review ON review_comments (review_id, created_at, id);
