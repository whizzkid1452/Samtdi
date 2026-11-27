ALTER TABLE web_media_versions ADD COLUMN peaks_revision smallint NOT NULL DEFAULT 1 CHECK (peaks_revision IN (1,2));
