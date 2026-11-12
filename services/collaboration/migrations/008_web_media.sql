CREATE TABLE web_media_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
    title text NOT NULL,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, id)
);

CREATE TABLE web_uploads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    item_id uuid NOT NULL,
    actor_id uuid NOT NULL REFERENCES accounts,
    filename text NOT NULL,
    description text NOT NULL DEFAULT '',
    bytes bigint NOT NULL CHECK (bytes BETWEEN 1 AND 500000000),
    kind text NOT NULL CHECK (kind IN ('wav', 'mp3')),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
    completion_key text,
    FOREIGN KEY (project_id,item_id) REFERENCES web_media_items(project_id,id),
    UNIQUE (project_id,actor_id,completion_key)
);

CREATE TABLE web_media_versions (
    id uuid PRIMARY KEY REFERENCES web_uploads,
    project_id uuid NOT NULL,
    item_id uuid NOT NULL,
    filename text NOT NULL,
    description text NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','ready','failed')),
    duration_ms bigint,
    failure text,
    original_key text,
    original_bytes bigint,
    original_hash text,
    playback_key text,
    playback_bytes bigint,
    playback_hash text,
    peaks_key text,
    peaks_bytes bigint,
    peaks_hash text,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id,item_id) REFERENCES web_media_items(project_id,id),
    UNIQUE (project_id,id)
);
CREATE INDEX web_media_versions_order ON web_media_versions (project_id,item_id,created_at DESC,id DESC);
CREATE INDEX web_media_items_order ON web_media_items (project_id,created_at DESC,id DESC);

CREATE TABLE web_media_jobs (
    version_id uuid PRIMARY KEY REFERENCES web_media_versions ON DELETE CASCADE,
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_id uuid,
    leased_until timestamptz,
    finished_at timestamptz
);
CREATE INDEX web_media_jobs_available ON web_media_jobs (available_at) WHERE finished_at IS NULL;
