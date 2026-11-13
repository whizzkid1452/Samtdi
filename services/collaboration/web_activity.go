package collaboration

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type webActivity struct {
	ID        string          `json:"id"`
	Action    string          `json:"action"`
	SubjectID string          `json:"subject_id"`
	Actor     string          `json:"actor"`
	Detail    json.RawMessage `json:"detail"`
	CreatedAt time.Time       `json:"created_at"`
}

func (s *Server) webActivityRoutes() {
	s.mux.HandleFunc("GET /v1/dashboard", s.withSession(s.webDashboard))
	s.mux.HandleFunc("GET /v1/projects/{project}/activity", s.withSession(s.listWebActivity))
}

func (s *Server) webDashboard(w http.ResponseWriter, r *http.Request, session Session) {
	var tasks json.RawMessage
	var review, due, late int
	err := s.pool.QueryRow(r.Context(), `WITH visible AS (
 SELECT t.id,t.project_id,p.title AS project_title,t.title,t.status,t.assignee_id,t.due_on
 FROM web_tasks t JOIN projects p ON p.id=t.project_id
 JOIN memberships m ON m.project_id=p.id AND m.account_id=$1
 WHERE NOT t.archived AND p.archived_at IS NULL AND t.status<>'done'
 ), mine AS (SELECT * FROM visible WHERE assignee_id=$1),
 upcoming AS (SELECT * FROM mine ORDER BY due_on NULLS LAST,id LIMIT 50)
 SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'project_id',project_id,'project_title',project_title,
 'title',title,'status',status,'due_on',COALESCE(due_on::text,'')) ORDER BY due_on NULLS LAST,id) FROM upcoming),'[]'),
 (SELECT count(*) FROM visible WHERE status='review'),
 (SELECT count(*) FROM mine WHERE due_on BETWEEN (now() AT TIME ZONE 'Asia/Seoul')::date AND (now() AT TIME ZONE 'Asia/Seoul')::date+7),
 (SELECT count(*) FROM mine WHERE due_on<(now() AT TIME ZONE 'Asia/Seoul')::date)`, session.AccountID).
		Scan(&tasks, &review, &due, &late)
	if err != nil {
		internal(w, "read_dashboard", err)
		return
	}
	writeJSON(w, 200, map[string]any{"tasks": tasks, "review_count": review, "due_soon_count": due, "late_count": late})
}

func (s *Server) listWebActivity(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.webRead(w, r, session) {
		return
	}
	var before int64
	var err error
	if cursor := r.URL.Query().Get("before"); cursor != "" {
		before, err = strconv.ParseInt(cursor, 10, 64)
		if err != nil || before < 1 {
			problem(w, 400, "invalid_cursor")
			return
		}
	}
	family := r.URL.Query().Get("type")
	switch family {
	case "", "project", "invitation", "membership", "media", "version", "note", "reply", "task":
	default:
		problem(w, 400, "invalid_activity_type")
		return
	}
	rows, err := s.pool.Query(r.Context(), `SELECT e.id::text,e.action,e.subject_id::text,COALESCE(a.email,'미디어 작업자'),e.detail,e.created_at
 FROM web_activity e LEFT JOIN accounts a ON a.id=e.actor_id
 WHERE e.project_id=$1 AND ($2=0 OR e.id<$2) AND ($3='' OR split_part(e.action,'.',1)=$3)
 ORDER BY e.id DESC LIMIT 50`, r.PathValue("project"), before, family)
	if err != nil {
		internal(w, "list_activity", err)
		return
	}
	events, err := pgx.CollectRows(rows, pgx.RowToStructByPos[webActivity])
	if err != nil {
		internal(w, "read_activity", err)
		return
	}
	writeJSON(w, 200, events)
}
