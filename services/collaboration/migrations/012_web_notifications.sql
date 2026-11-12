CREATE TABLE web_notifications (
    recipient_id uuid NOT NULL REFERENCES accounts,
    activity_id bigint NOT NULL REFERENCES web_activity ON DELETE CASCADE,
    read_at timestamptz,
    PRIMARY KEY (recipient_id,activity_id)
);

CREATE FUNCTION notify_web_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.action IN ('task.created','task.updated') THEN
        INSERT INTO web_notifications (recipient_id,activity_id)
        SELECT m.account_id, NEW.id FROM memberships m
        WHERE m.project_id=NEW.project_id AND m.account_id=NULLIF(NEW.detail->>'assignee_id','')::uuid
          AND m.account_id IS DISTINCT FROM NEW.actor_id
          AND NEW.detail->>'assignee_id' IS DISTINCT FROM NEW.detail->>'previous_assignee_id'
        ON CONFLICT DO NOTHING;
    ELSIF NEW.action='reply.created' THEN
        INSERT INTO web_notifications (recipient_id,activity_id)
        SELECT DISTINCT participant.account_id,NEW.id FROM (
            SELECT n.author_id AS account_id FROM web_notes n
            WHERE n.project_id=NEW.project_id AND n.id=(NEW.detail->>'note_id')::uuid
            UNION
            SELECT r.author_id FROM web_note_replies r
            WHERE r.project_id=NEW.project_id AND r.note_id=(NEW.detail->>'note_id')::uuid AND NOT r.deleted
        ) participant JOIN memberships m ON m.account_id=participant.account_id AND m.project_id=NEW.project_id
        WHERE participant.account_id IS DISTINCT FROM NEW.actor_id
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER web_activity_notification AFTER INSERT ON web_activity FOR EACH ROW EXECUTE FUNCTION notify_web_activity();
