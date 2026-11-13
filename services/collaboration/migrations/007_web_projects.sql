ALTER TABLE projects ADD COLUMN archived_at timestamptz;

CREATE TABLE web_activity (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
    actor_id uuid REFERENCES accounts,
    action text NOT NULL,
    subject_id uuid NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX web_activity_project_order ON web_activity (project_id, id DESC);
