ALTER TABLE workspaces ADD COLUMN personal boolean NOT NULL DEFAULT false;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_personal_scope CHECK (NOT personal OR (active AND organization_id IS NULL));
CREATE UNIQUE INDEX workspaces_personal_owner ON workspaces(created_by) WHERE personal;
