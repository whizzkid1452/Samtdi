CREATE TABLE review_media_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id uuid NOT NULL REFERENCES reviews ON DELETE CASCADE,
    requested_by uuid NOT NULL REFERENCES accounts,
    commit_oid text NOT NULL CHECK (commit_oid ~ '^[0-9a-f]{40}$'),
    renderer_hash text NOT NULL CHECK (renderer_hash ~ '^[0-9a-f]{64}$'),
    settings_hash text NOT NULL CHECK (settings_hash ~ '^[0-9a-f]{64}$'),
    settings jsonb NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','ready','incomplete','failed')),
    lease_id uuid,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    manifest jsonb,
    reason text,
    mix_oid text CHECK (mix_oid ~ '^[0-9a-f]{64}$'),
    mix_bytes bigint CHECK (mix_bytes > 44 AND mix_bytes <= 2147483648),
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE (review_id, commit_oid, renderer_hash, settings_hash)
);

CREATE INDEX review_media_queue ON review_media_versions (renderer_hash, created_at) WHERE state IN ('queued','running');
CREATE INDEX review_media_by_review ON review_media_versions (review_id, created_at DESC);
