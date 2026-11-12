CREATE TABLE web_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    version_id uuid NOT NULL,
    author_id uuid NOT NULL REFERENCES accounts,
    start_ms bigint NOT NULL CHECK (start_ms >= 0),
    end_ms bigint CHECK (end_ms > start_ms),
    body text NOT NULL,
    resolved boolean NOT NULL DEFAULT false,
    deleted boolean NOT NULL DEFAULT false,
    revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id,version_id) REFERENCES web_media_versions(project_id,id),
    UNIQUE (project_id,id)
);
CREATE INDEX web_notes_version_order ON web_notes (project_id,version_id,created_at,id);

CREATE TABLE web_note_replies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL,
    note_id uuid NOT NULL,
    author_id uuid NOT NULL REFERENCES accounts,
    body text NOT NULL,
    deleted boolean NOT NULL DEFAULT false,
    revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id,note_id) REFERENCES web_notes(project_id,id)
);
CREATE INDEX web_replies_note_order ON web_note_replies (note_id,created_at,id);

CREATE TABLE web_note_edits (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
    subject_id uuid NOT NULL,
    actor_id uuid NOT NULL REFERENCES accounts,
    revision integer NOT NULL,
    previous_body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
