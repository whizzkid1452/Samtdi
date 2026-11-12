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
	query := r.URL.Query()
	filter, after := query.Get("filter"), query.Get("after")
	if filter == "" {
		filter = "assigned"
	}
	if (filter != "assigned" && filter != "review" && filter != "due" && filter != "late") ||
		(after != "" && !uuidPattern.MatchString(after)) {
		problem(w, 400, "invalid_dashboard_filter")
		return
	}

	var tasks json.RawMessage
	var assigned, review, due, late int
	var next string
	err := s.pool.QueryRow(r.Context(), `WITH visible AS (
 SELECT t.id,t.project_id,p.title AS project_title,t.title,t.status,t.due_on,
 COALESCE(t.due_on,'infinity'::date) AS sort_date,
 t.assignee_id=$1 AS assigned,
 (t.status='review') AS review,
 t.assignee_id=$1 AND t.due_on BETWEEN (now() AT TIME ZONE 'Asia/Seoul')::date AND (now() AT TIME ZONE 'Asia/Seoul')::date+7 AS due,
 t.assignee_id=$1 AND t.due_on<(now() AT TIME ZONE 'Asia/Seoul')::date AS late
 FROM web_tasks t JOIN projects p ON p.id=t.project_id
 JOIN memberships m ON m.project_id=p.id AND m.account_id=$1
 WHERE NOT t.archived AND p.archived_at IS NULL AND t.status<>'done'
 ), filtered AS (
 SELECT * FROM visible WHERE CASE $2 WHEN 'review' THEN review WHEN 'due' THEN due WHEN 'late' THEN late ELSE assigned END
 ), candidates AS (
 SELECT * FROM filtered WHERE $3='' OR (sort_date,id)>(
 SELECT sort_date,id FROM filtered WHERE id=NULLIF($3,'')::uuid)
 ORDER BY sort_date,id LIMIT 51
 ), page AS (SELECT * FROM candidates ORDER BY sort_date,id LIMIT 50)
 SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'project_id',project_id,'project_title',project_title,
 'title',title,'status',status,'due_on',COALESCE(due_on::text,'')) ORDER BY sort_date,id) FROM page),'[]'),
 count(*) FILTER(WHERE assigned),count(*) FILTER(WHERE review),count(*) FILTER(WHERE due),count(*) FILTER(WHERE late),
 CASE WHEN (SELECT count(*) FROM candidates)>50 THEN (SELECT id::text FROM page ORDER BY sort_date DESC,id DESC LIMIT 1) ELSE '' END
 FROM visible`, session.AccountID, filter, after).Scan(&tasks, &assigned, &review, &due, &late, &next)
	if err != nil {
		internal(w, "read_dashboard", err)
		return
	}

	writeJSON(w, 200, map[string]any{
		"tasks": tasks, "assigned_count": assigned, "review_count": review,
		"due_soon_count": due, "late_count": late, "next_cursor": next,
	})
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
