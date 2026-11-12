CREATE TABLE web_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    status text NOT NULL CHECK (status IN ('todo','progress','review','done')),
    assignee_id uuid REFERENCES accounts,
    due_on date,
    result_version_id uuid,
    review_text text NOT NULL DEFAULT '',
    position bigint NOT NULL CHECK (position >= 0),
    archived boolean NOT NULL DEFAULT false,
    revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id,result_version_id) REFERENCES web_media_versions(project_id,id),
    UNIQUE (project_id,id)
);
CREATE INDEX web_tasks_board ON web_tasks(project_id,status,position,id);
CREATE INDEX web_tasks_assignee ON web_tasks(assignee_id,project_id) WHERE NOT archived;

CREATE TABLE web_task_notes (
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    note_id uuid NOT NULL,
    PRIMARY KEY (task_id,note_id),
    FOREIGN KEY (project_id,task_id) REFERENCES web_tasks(project_id,id) ON DELETE CASCADE,
    FOREIGN KEY (project_id,note_id) REFERENCES web_notes(project_id,id)
);
