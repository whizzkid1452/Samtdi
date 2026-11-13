CREATE TABLE lfs_objects (
    project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
    oid text NOT NULL CHECK (oid ~ '^[0-9a-f]{64}$'),
    size bigint NOT NULL CHECK (size BETWEEN 0 AND 2147483648),
    verified_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, oid)
);
