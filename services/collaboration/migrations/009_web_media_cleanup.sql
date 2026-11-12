ALTER TABLE web_uploads ADD COLUMN cleaned_at timestamptz;

CREATE TABLE web_media_garbage (
    object_key text PRIMARY KEY,
    available_at timestamptz NOT NULL
);
