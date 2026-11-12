package collaboration

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type webTaskNote struct {
	ID        string `json:"id"`
	VersionID string `json:"version_id"`
	StartMS   int64  `json:"start_ms"`
	Body      string `json:"body"`
	Resolved  bool   `json:"resolved"`
	Deleted   bool   `json:"deleted"`
	Revision  int    `json:"revision"`
}

type webTask struct {
	ID              string        `json:"id"`
	Title           string        `json:"title"`
	Description     string        `json:"description"`
	Status          string        `json:"status"`
	AssigneeID      string        `json:"assignee_id"`
	DueOn           string        `json:"due_on"`
	ResultVersionID string        `json:"result_version_id"`
	ReviewText      string        `json:"review_text"`
	Position        int64         `json:"position"`
	Archived        bool          `json:"archived"`
	Revision        int           `json:"revision"`
	Notes           []webTaskNote `json:"notes"`
}

const webTaskNoteJSON = `jsonb_build_object('id',n.id,'version_id',n.version_id,'start_ms',n.start_ms,
 'body',CASE WHEN n.deleted THEN '' ELSE n.body END,'resolved',n.resolved,'deleted',n.deleted,'revision',n.revision)`
const webTaskSelect = `SELECT t.id::text,t.title,t.description,t.status,COALESCE(t.assignee_id::text,''),
 COALESCE(t.due_on::text,''),COALESCE(t.result_version_id::text,''),t.review_text,t.position,t.archived,t.revision,
 COALESCE((SELECT jsonb_agg(` + webTaskNoteJSON + ` ORDER BY n.created_at,n.id)
 FROM web_task_notes l JOIN web_notes n ON n.id=l.note_id WHERE l.task_id=t.id),'[]'::jsonb)
 FROM web_tasks t`

type webNoteConfirmation struct {
	ID       string `json:"id"`
	Revision int    `json:"revision"`
}

type webTaskInput struct {
	Title           string                `json:"title"`
	Description     string                `json:"description"`
	Status          string                `json:"status"`
	AssigneeID      string                `json:"assignee_id"`
	DueOn           string                `json:"due_on"`
	ResultVersionID string                `json:"result_version_id"`
	ReviewText      string                `json:"review_text"`
	Position        *int64                `json:"position"`
	Archived        bool                  `json:"archived"`
	Revision        int                   `json:"revision"`
	NoteIDs         []string              `json:"note_ids"`
	ConfirmNotes    []webNoteConfirmation `json:"confirm_notes"`
}

func (input webTaskInput) valid() bool {
	if !webText(input.Title, 160) || utf8.RuneCountInString(input.Description) > 4000 || utf8.RuneCountInString(input.ReviewText) > 2000 ||
		strings.ContainsRune(input.Description, 0) || strings.ContainsRune(input.ReviewText, 0) || len(input.NoteIDs) > 50 || len(input.ConfirmNotes) > 50 {
		return false
	}
	if input.AssigneeID != "" && !uuidPattern.MatchString(input.AssigneeID) ||
		input.ResultVersionID != "" && !uuidPattern.MatchString(input.ResultVersionID) ||
		input.Position != nil && (*input.Position < 0 || *input.Position > 1_000_000_000) {
		return false
	}
	if input.DueOn != "" {
		if _, err := time.Parse(time.DateOnly, input.DueOn); err != nil {
			return false
		}
	}
	for _, id := range input.NoteIDs {
		if !uuidPattern.MatchString(id) {
			return false
		}
	}
	switch input.Status {
	case "todo", "progress", "review", "done":
		return true
	default:
		return false
	}
}

func (s *Server) webTaskRoutes() {
	base := "/v1/projects/{project}"
	s.mux.HandleFunc("GET "+base+"/tasks", s.withSession(s.listWebTasks))
	s.mux.HandleFunc("POST "+base+"/tasks", s.withSession(s.saveWebTask))
	s.mux.HandleFunc("PUT "+base+"/tasks/{task}", s.withSession(s.saveWebTask))
	s.mux.HandleFunc("GET "+base+"/task-options", s.withSession(s.webTaskOptions))
}

func (s *Server) listWebTasks(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.webRead(w, r, session) {
		return
	}
	cursor := r.URL.Query().Get("after")
	if cursor != "" && !uuidPattern.MatchString(cursor) {
		problem(w, 400, "invalid_cursor")
		return
	}
	rows, err := s.pool.Query(r.Context(), webTaskSelect+` WHERE t.project_id=$1 AND ($2='' OR
 (t.status,t.position,t.id)>(SELECT status,position,id FROM web_tasks WHERE project_id=$1 AND id=NULLIF($2,'')::uuid))
 ORDER BY t.status,t.position,t.id LIMIT 100`, r.PathValue("project"), cursor)
	if err != nil {
		internal(w, "list_web_tasks", err)
		return
	}
	value, err := pgx.CollectRows(rows, pgx.RowToStructByPos[webTask])
	if err != nil {
		internal(w, "read_web_tasks", err)
		return
	}
	writeJSON(w, 200, value)
}

func (s *Server) webTaskOptions(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.webRead(w, r, session) {
		return
	}
	var notes, versions json.RawMessage
	err := s.pool.QueryRow(r.Context(), `SELECT
 COALESCE((SELECT jsonb_agg(item) FROM (SELECT `+webTaskNoteJSON+` AS item FROM web_notes n
 WHERE n.project_id=$1 ORDER BY n.created_at DESC,n.id DESC LIMIT 100) recent),'[]'::jsonb),
 COALESCE((SELECT jsonb_agg(item) FROM (SELECT jsonb_build_object('id',v.id,'filename',v.filename) AS item
 FROM web_media_versions v WHERE v.project_id=$1 AND v.state='ready' ORDER BY v.created_at DESC,v.id DESC LIMIT 100) recent),'[]'::jsonb)`,
		r.PathValue("project")).Scan(&notes, &versions)
	if err != nil {
		internal(w, "read_task_options", err)
		return
	}
	writeJSON(w, 200, map[string]json.RawMessage{"notes": notes, "versions": versions})
}

func validateWebTaskLinks(ctx context.Context, tx pgx.Tx, project string, input webTaskInput) error {
	if input.AssigneeID != "" {
		role, err := readRole(ctx, tx, project, input.AssigneeID)
		if err != nil || !role.canWrite() {
			return webProblem{400, "invalid_assignee"}
		}
	}
	if input.ResultVersionID != "" {
		var ready bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM web_media_versions WHERE project_id=$1 AND id=$2 AND state='ready')`,
			project, input.ResultVersionID).Scan(&ready)
		if err != nil {
			return err
		}
		if !ready {
			return webProblem{400, "invalid_result_version"}
		}
	}
	if input.Status == "review" && input.ResultVersionID == "" && strings.TrimSpace(input.ReviewText) == "" {
		return webProblem{400, "review_evidence_required"}
	}
	seen := make(map[string]bool, len(input.NoteIDs))
	confirmed := make(map[string]int, len(input.ConfirmNotes))
	for _, note := range input.ConfirmNotes {
		confirmed[note.ID] = note.Revision
	}
	for _, id := range input.NoteIDs {
		if seen[id] {
			return webProblem{400, "duplicate_note"}
		}
		seen[id] = true
		var unresolved bool
		var revision int
		err := tx.QueryRow(ctx, `SELECT NOT resolved AND NOT deleted,revision FROM web_notes WHERE project_id=$1 AND id=$2`, project, id).
			Scan(&unresolved, &revision)
		if err != nil {
			return err
		}
		if input.Status == "done" && unresolved && confirmed[id] != revision {
			return webProblem{409, "unresolved_note_confirmation_required"}
		}
	}
	return nil
}

func (s *Server) saveWebTask(w http.ResponseWriter, r *http.Request, session Session) {
	var input webTaskInput
	if !readJSON(w, r, &input) {
		return
	}
	task, project := r.PathValue("task"), r.PathValue("project")
	if !input.valid() || task != "" && (!uuidPattern.MatchString(task) || input.Revision < 1) {
		problem(w, 400, "invalid_task")
		return
	}
	status := 200
	if task == "" {
		status = 201
	}
	s.webWrite(w, r, session, Editor, false, status, func(ctx context.Context, tx pgx.Tx, _ Role) (any, error) {
		var previousStatus string
		var previousAssignee string
		var previousPosition int64
		if task != "" {
			var revision int
			err := tx.QueryRow(ctx, `SELECT revision,status,position,COALESCE(assignee_id::text,'') FROM web_tasks WHERE project_id=$1 AND id=$2`, project, task).
				Scan(&revision, &previousStatus, &previousPosition, &previousAssignee)
			if err != nil {
				return nil, err
			}
			if revision != input.Revision {
				return nil, webProblem{409, "revision_conflict"}
			}
		}
		if err := validateWebTaskLinks(ctx, tx, project, input); err != nil {
			return nil, err
		}
		position := previousPosition
		if input.Position != nil {
			position = *input.Position
			if position != previousPosition || previousStatus != input.Status {
				if _, err := tx.Exec(ctx, `UPDATE web_tasks SET position=position+1,revision=revision+1
 WHERE project_id=$1 AND status=$2 AND position>=$3 AND id IS DISTINCT FROM NULLIF($4,'')::uuid`, project, input.Status, position, task); err != nil {
					return nil, err
				}
			}
		} else if previousStatus != input.Status {
			if err := tx.QueryRow(ctx, `SELECT COALESCE(max(position)+1,0) FROM web_tasks WHERE project_id=$1 AND status=$2`, project, input.Status).Scan(&position); err != nil {
				return nil, err
			}
		}
		action := "task.updated"
		args := []any{project, strings.TrimSpace(input.Title), input.Description, input.Status, input.AssigneeID, input.DueOn,
			input.ResultVersionID, input.ReviewText, position, input.Archived}
		if task == "" {
			action = "task.created"
			err := tx.QueryRow(ctx, `INSERT INTO web_tasks(project_id,title,description,status,assignee_id,due_on,result_version_id,review_text,position,archived)
 VALUES ($1,$2,$3,$4,NULLIF($5,'')::uuid,NULLIF($6,'')::date,NULLIF($7,'')::uuid,$8,$9,$10) RETURNING id::text`, args...).Scan(&task)
			if err != nil {
				return nil, err
			}
		} else {
			if _, err := tx.Exec(ctx, `UPDATE web_tasks SET title=$2,description=$3,status=$4,assignee_id=NULLIF($5,'')::uuid,
 due_on=NULLIF($6,'')::date,result_version_id=NULLIF($7,'')::uuid,review_text=$8,position=$9,archived=$10,revision=revision+1
 WHERE project_id=$1 AND id=$11`, append(args, task)...); err != nil {
				return nil, err
			}
		}
		if _, err := tx.Exec(ctx, "DELETE FROM web_task_notes WHERE task_id=$1", task); err != nil {
			return nil, err
		}
		for _, note := range input.NoteIDs {
			if _, err := tx.Exec(ctx, "INSERT INTO web_task_notes(project_id,task_id,note_id) VALUES ($1,$2,$3)", project, task, note); err != nil {
				return nil, err
			}
		}
		if err := appendWebActivity(ctx, tx, project, session.AccountID, action, task, map[string]any{"status": input.Status, "assignee_id": input.AssigneeID, "previous_assignee_id": previousAssignee, "archived": input.Archived}); err != nil {
			return nil, err
		}
		return map[string]string{"id": task}, nil
	})
}
