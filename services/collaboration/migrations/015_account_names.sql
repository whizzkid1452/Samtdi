ALTER TABLE accounts ADD COLUMN display_name text
    CHECK (display_name IS NULL OR (char_length(display_name) BETWEEN 1 AND 40 AND display_name = btrim(display_name)));
