package collaboration

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type webProblem struct {
	status int
	code   string
}

func (p webProblem) Error() string { return p.code }

func writeWebError(w http.ResponseWriter, operation string, err error) {
	var failure webProblem
	switch {
	case errors.As(err, &failure):
		problem(w, failure.status, failure.code)
	case errors.Is(err, pgx.ErrNoRows):
		problem(w, http.StatusNotFound, "resource_not_found")
	default:
		internal(w, operation, err)
	}
}

type webChange func(context.Context, pgx.Tx, Role) (any, error)

func (s *Server) webWrite(w http.ResponseWriter, r *http.Request, session Session, minimum Role, allowArchived bool, status int, change webChange) {
	ctx := r.Context()
	projectID := r.PathValue("project")
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		internal(w, "begin_web_change", err)
		return
	}
	defer tx.Rollback(ctx)

	if err := lockProject(ctx, tx, projectID); err != nil {
		writeWebError(w, "lock_web_project", err)
		return
	}
	role, err := readRole(ctx, tx, projectID, session.AccountID)
	allowed := role.valid()
	if minimum == Editor {
		allowed = role.canWrite()
	} else if minimum == Owner {
		allowed = role == Owner
	}
	if !requireRole(w, role, err, allowed) {
		return
	}
	if !allowArchived && !requireActiveProject(w, ctx, tx, projectID) {
		return
	}

	value, err := change(ctx, tx, role)
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		writeWebError(w, "apply_web_change", err)
		return
	}
	if status == http.StatusNoContent {
		w.WriteHeader(status)
		return
	}
	writeJSON(w, status, value)
}

func requireActiveProject(w http.ResponseWriter, ctx context.Context, db rowQuerier, projectID string) bool {
	var active bool
	err := db.QueryRow(ctx, "SELECT archived_at IS NULL FROM projects WHERE id=$1", projectID).Scan(&active)
	if err != nil {
		writeWebError(w, "read_project_state", err)
		return false
	}
	if !active {
		problem(w, http.StatusConflict, "project_archived")
	}
	return active
}

func (s *Server) webRead(w http.ResponseWriter, r *http.Request, session Session) bool {
	role, err := readRole(r.Context(), s.pool, r.PathValue("project"), session.AccountID)
	return requireRole(w, role, err, role.valid())
}

func appendWebActivity(ctx context.Context, tx pgx.Tx, project, actor, action, subject string, detail map[string]any) error {
	if detail == nil {
		detail = map[string]any{}
	}
	_, err := tx.Exec(ctx, `INSERT INTO web_activity(project_id, actor_id, action, subject_id, detail)
 VALUES ($1, NULLIF($2,'')::uuid, $3, $4, $5)`, project, actor, action, subject, detail)
	return err
}

func webText(value string, maxRunes int) bool {
	return strings.TrimSpace(value) != "" && !strings.ContainsRune(value, 0) && utf8.RuneCountInString(value) <= maxRunes
}

func (s *Server) archiveWebProject(w http.ResponseWriter, r *http.Request, session Session) {
	var input struct {
		Archived *bool `json:"archived"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if input.Archived == nil {
		problem(w, http.StatusBadRequest, "invalid_archive_state")
		return
	}

	projectID := r.PathValue("project")
	s.webWrite(w, r, session, Owner, true, http.StatusNoContent, func(ctx context.Context, tx pgx.Tx, _ Role) (any, error) {
		result, err := tx.Exec(ctx, `UPDATE projects SET archived_at=CASE WHEN $2 THEN now() ELSE NULL END
 WHERE id=$1 AND (archived_at IS NOT NULL) <> $2`, projectID, *input.Archived)
		if err != nil || result.RowsAffected() == 0 {
			return nil, err
		}

		action := "project.restored"
		if *input.Archived {
			action = "project.archived"
		}
		return nil, appendWebActivity(ctx, tx, projectID, session.AccountID, action, projectID, nil)
	})
}
