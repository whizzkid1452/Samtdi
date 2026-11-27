package collaboration

import (
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type webNotification struct {
	ID           string     `json:"id"`
	ProjectID    string     `json:"project_id"`
	ProjectTitle string     `json:"project_title"`
	Action       string     `json:"action"`
	SubjectID    string     `json:"subject_id"`
	VersionID    string     `json:"version_id"`
	NoteID       string     `json:"note_id"`
	ActorID      string     `json:"actor_id"`
	ActorName    string     `json:"actor_name"`
	ActorEmail   string     `json:"actor_email"`
	Title        string     `json:"title"`
	CreatedAt    time.Time  `json:"created_at"`
	ReadAt       *time.Time `json:"read_at,omitempty"`
}

func (s *Server) webNotificationRoutes() {
	s.mux.HandleFunc("GET /v1/notifications", s.withSession(s.listWebNotifications))
	s.mux.HandleFunc("POST /v1/notifications/read-all", s.withSession(s.readAllWebNotifications))
	s.mux.HandleFunc("POST /v1/notifications/{notification}/read", s.withSession(s.readWebNotification))
}

func (s *Server) listWebNotifications(w http.ResponseWriter, r *http.Request, session Session) {
	var cursor int64
	if raw := r.URL.Query().Get("before"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 1 {
			problem(w, 400, "invalid_cursor")
			return
		}
		cursor = parsed
	}
	ctx := r.Context()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		internal(w, "begin_notifications", err)
		return
	}
	defer tx.Rollback(ctx)
	const visible = ` FROM web_notifications n JOIN web_activity e ON e.id=n.activity_id
 JOIN projects p ON p.id=e.project_id LEFT JOIN accounts actor ON actor.id=e.actor_id JOIN memberships m ON m.project_id=p.id AND m.account_id=n.recipient_id
 WHERE n.recipient_id=$1 AND (p.workspace_id IS NULL OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.active AND w.organization_id=ANY($2::text[])))`
	var unread int
	err = tx.QueryRow(ctx, "SELECT count(*)"+visible+" AND n.read_at IS NULL", session.AccountID, session.organizationIDs()).Scan(&unread)
	if err != nil {
		internal(w, "count_notifications", err)
		return
	}
	rows, err := tx.Query(ctx, `SELECT e.id::text,p.id::text,p.title,e.action,e.subject_id::text,
 COALESCE(e.detail->>'version_id',''),COALESCE(e.detail->>'note_id',''),
 COALESCE(actor.id::text,''),COALESCE(actor.display_name,''),COALESCE(actor.email,''),
 COALESCE(CASE WHEN split_part(e.action,'.',1)='task' THEN (SELECT t.title FROM web_tasks t WHERE t.project_id=e.project_id AND t.id=e.subject_id)
 WHEN e.action='reply.created' THEN (SELECT left(r.body,120) FROM web_note_replies r WHERE r.project_id=e.project_id AND r.id=e.subject_id AND NOT r.deleted) END,''),
 e.created_at,n.read_at`+visible+
		" AND ($3::bigint=0 OR e.id<$3) ORDER BY e.id DESC LIMIT 50", session.AccountID, session.organizationIDs(), cursor)
	if err != nil {
		internal(w, "list_notifications", err)
		return
	}
	items, err := pgx.CollectRows(rows, pgx.RowToStructByPos[webNotification])
	if err != nil {
		internal(w, "read_notifications", err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items, "unread": unread})
}

func (s *Server) readWebNotification(w http.ResponseWriter, r *http.Request, session Session) {
	id, err := strconv.ParseInt(r.PathValue("notification"), 10, 64)
	if err != nil || id < 1 {
		problem(w, 404, "resource_not_found")
		return
	}
	result, err := s.pool.Exec(r.Context(), `UPDATE web_notifications n SET read_at=COALESCE(n.read_at,now())
 FROM web_activity e JOIN memberships m ON m.project_id=e.project_id JOIN projects p ON p.id=e.project_id
 WHERE n.activity_id=e.id AND n.activity_id=$1 AND n.recipient_id=$2 AND m.account_id=$2
 AND (p.workspace_id IS NULL OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.active AND w.organization_id=ANY($3::text[])))`, id, session.AccountID, session.organizationIDs())
	if err != nil {
		internal(w, "mark_notification_read", err)
		return
	}
	if result.RowsAffected() != 1 {
		problem(w, 404, "resource_not_found")
		return
	}
	w.WriteHeader(204)
}

func (s *Server) readAllWebNotifications(w http.ResponseWriter, r *http.Request, session Session) {
	_, err := s.pool.Exec(r.Context(), `UPDATE web_notifications n SET read_at=now()
 FROM web_activity e JOIN memberships m ON m.project_id=e.project_id JOIN projects p ON p.id=e.project_id
 WHERE n.activity_id=e.id AND n.recipient_id=$1 AND m.account_id=$1 AND n.read_at IS NULL
 AND (p.workspace_id IS NULL OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.active AND w.organization_id=ANY($2::text[])))`, session.AccountID, session.organizationIDs())
	if err != nil {
		internal(w, "mark_all_notifications_read", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
