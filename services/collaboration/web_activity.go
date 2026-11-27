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
	ActorID   string          `json:"actor_id"`
	ActorName string          `json:"actor_name"`
	Detail    json.RawMessage `json:"detail"`
	CreatedAt time.Time       `json:"created_at"`
}

func (s *Server) webActivityRoutes() {
	s.mux.HandleFunc("GET /v1/dashboard", s.withSession(s.webDashboard))
	s.mux.HandleFunc("GET /v1/dashboard/overview", s.withSession(s.webDashboardOverview))
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
 SELECT t.id,t.project_id,p.title AS project_title,t.title,t.status,t.due_on,t.start_on,t.assignee_id,
 (SELECT count(*) FROM web_task_notes l WHERE l.task_id=t.id) AS note_count,`+webTaskSourceJSON+` AS source,
 (SELECT jsonb_build_object('name',COALESCE(a.display_name,''),'email',a.email) FROM accounts a WHERE a.id=t.assignee_id) AS assignee,
 COALESCE(t.due_on,'infinity'::date) AS sort_date,
 t.assignee_id=$1 AS assigned,
 (t.status='review') AS review,
 t.assignee_id=$1 AND t.due_on BETWEEN (now() AT TIME ZONE 'Asia/Seoul')::date AND (now() AT TIME ZONE 'Asia/Seoul')::date+7 AS due,
 t.assignee_id=$1 AND t.due_on<(now() AT TIME ZONE 'Asia/Seoul')::date AS late
 FROM web_tasks t JOIN projects p ON p.id=t.project_id
 JOIN memberships m ON m.project_id=p.id AND m.account_id=$1
 WHERE NOT t.archived AND p.archived_at IS NULL AND t.status<>'done'
 AND (p.workspace_id IS NULL OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.active AND (w.personal OR w.organization_id=ANY($4::text[]))))
 ), filtered AS (
 SELECT * FROM visible WHERE CASE $2 WHEN 'review' THEN review WHEN 'due' THEN due WHEN 'late' THEN late ELSE assigned END
 ), candidates AS (
 SELECT * FROM filtered WHERE $3='' OR (sort_date,id)>(
 SELECT sort_date,id FROM filtered WHERE id=NULLIF($3,'')::uuid)
 ORDER BY sort_date,id LIMIT 51
 ), page AS (SELECT * FROM candidates ORDER BY sort_date,id LIMIT 50)
 SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'project_id',project_id,'project_title',project_title,
 'title',title,'status',status,'due_on',COALESCE(due_on::text,''),'start_on',COALESCE(start_on::text,''),
 'assignee_id',COALESCE(assignee_id::text,''),'assignee',assignee,'note_count',note_count,'source',source) ORDER BY sort_date,id) FROM page),'[]'),
 count(*) FILTER(WHERE assigned),count(*) FILTER(WHERE review),count(*) FILTER(WHERE due),count(*) FILTER(WHERE late),
 CASE WHEN (SELECT count(*) FROM candidates)>50 THEN (SELECT id::text FROM page ORDER BY sort_date DESC,id DESC LIMIT 1) ELSE '' END
 FROM visible`, session.AccountID, filter, after, session.organizationIDs()).Scan(&tasks, &assigned, &review, &due, &late, &next)
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
	rows, err := s.pool.Query(r.Context(), `SELECT e.id::text,e.action,e.subject_id::text,COALESCE(a.email,'미디어 작업자'),COALESCE(a.id::text,''),
 COALESCE(a.display_name,''),e.detail,e.created_at
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

// webDashboardOverview gathers what is waiting for the viewer outside their task list:
// open feedback others left on versions they uploaded, and the latest playable versions in their projects.
func (s *Server) webDashboardOverview(w http.ResponseWriter, r *http.Request, session Session) {
	var feedback, versions json.RawMessage
	err := s.pool.QueryRow(r.Context(), `WITH mine AS (
 SELECT p.id,p.title FROM projects p JOIN memberships m ON m.project_id=p.id AND m.account_id=$1 WHERE p.archived_at IS NULL
 AND (p.workspace_id IS NULL OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.active AND (w.personal OR w.organization_id=ANY($2::text[]))))
 ), feedback AS (
 SELECT n.id,n.created_at,jsonb_strip_nulls(jsonb_build_object('id',n.id,'project_id',mine.id,'project_title',mine.title,'item_id',i.id,
 'item_title',i.title,'version_id',v.id,'filename',v.filename,'start_ms',n.start_ms,'end_ms',n.end_ms,'body',n.body,
 'author_id',a.id,'author_name',COALESCE(a.display_name,''),'author_email',a.email,'created_at',n.created_at)) AS item
 FROM web_notes n JOIN mine ON mine.id=n.project_id JOIN web_media_versions v ON v.id=n.version_id
 JOIN web_uploads u ON u.id=v.id JOIN web_media_items i ON i.id=v.item_id JOIN accounts a ON a.id=n.author_id
 WHERE u.actor_id=$1 AND n.author_id<>$1 AND NOT n.deleted AND NOT n.resolved AND i.archived_at IS NULL
 AND n.created_at>now()-interval '14 days' ORDER BY n.created_at DESC,n.id DESC LIMIT 8
 ), versions AS (
 SELECT v.id,v.created_at,jsonb_build_object('id',v.id,'project_id',mine.id,'project_title',mine.title,'item_id',i.id,'item_title',i.title,
 'filename',v.filename,'created_at',v.created_at,'uploader_id',a.id,'uploader_name',COALESCE(a.display_name,''),'uploader_email',a.email,
 'open_notes',(SELECT count(*) FROM web_notes n WHERE n.version_id=v.id AND NOT n.deleted AND NOT n.resolved)) AS item
 FROM web_media_versions v JOIN mine ON mine.id=v.project_id JOIN web_media_items i ON i.id=v.item_id
 JOIN web_uploads u ON u.id=v.id JOIN accounts a ON a.id=u.actor_id
 WHERE v.state='ready' AND i.archived_at IS NULL ORDER BY v.created_at DESC,v.id DESC LIMIT 6
 )
 SELECT COALESCE((SELECT jsonb_agg(item ORDER BY created_at DESC,id DESC) FROM feedback),'[]'),
 COALESCE((SELECT jsonb_agg(item ORDER BY created_at DESC,id DESC) FROM versions),'[]')`, session.AccountID, session.organizationIDs()).Scan(&feedback, &versions)
	if err != nil {
		internal(w, "read_dashboard_overview", err)
		return
	}
	writeJSON(w, 200, map[string]json.RawMessage{"feedback": feedback, "versions": versions})
}
