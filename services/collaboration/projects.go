package collaboration

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type Role string

const (
	Reviewer Role = "reviewer"
	Editor   Role = "editor"
	Owner    Role = "owner"
)

func (role Role) valid() bool {
	return role == Reviewer || role == Editor || role == Owner
}

func (role Role) canWrite() bool {
	return role == Editor || role == Owner
}

type project struct {
	ID         string     `json:"id"`
	Title      string     `json:"title"`
	Role       Role       `json:"role"`
	ArchivedAt *time.Time `json:"archived_at,omitempty"`
	UpdatedAt  *time.Time `json:"updated_at,omitempty"`
}

type member struct {
	AccountID string `json:"account_id"`
	Email     string `json:"email"`
	Role      Role   `json:"role"`
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func readRole(ctx context.Context, db rowQuerier, projectID, accountID string) (Role, error) {
	if !uuidPattern.MatchString(projectID) || !uuidPattern.MatchString(accountID) {
		return "", pgx.ErrNoRows
	}

	var role Role
	err := db.QueryRow(ctx, `SELECT role FROM memberships WHERE project_id = $1 AND account_id = $2`, projectID, accountID).Scan(&role)
	return role, err
}

func requireRole(w http.ResponseWriter, role Role, err error, allowed bool) bool {
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		problem(w, http.StatusNotFound, "project_not_found")
	case err != nil:
		internal(w, "read_project_role", err)
	case !allowed || !role.valid():
		problem(w, http.StatusForbidden, "insufficient_role")
	default:
		return true
	}

	return false
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request, session Session) {
	rows, err := s.pool.Query(r.Context(), `SELECT p.id::text AS id, p.title, m.role, p.archived_at, COALESCE(recent.created_at,p.created_at) AS updated_at FROM projects p
 JOIN memberships m ON m.project_id=p.id
 LEFT JOIN LATERAL (SELECT created_at FROM web_activity WHERE project_id=p.id ORDER BY id DESC LIMIT 1) recent ON true
 WHERE m.account_id=$1 ORDER BY p.created_at,p.id`, session.AccountID)
	if err != nil {
		internal(w, "list_projects", err)
		return
	}

	projects, err := pgx.CollectRows(rows, pgx.RowToStructByName[project])
	if err != nil {
		internal(w, "read_projects", err)
		return
	}

	writeJSON(w, http.StatusOK, projects)
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request, session Session) {
	var input struct {
		Title string `json:"title"`
	}
	if !readJSON(w, r, &input) {
		return
	}

	title := strings.TrimSpace(input.Title)
	if title == "" || utf8.RuneCountInString(title) > 160 || strings.ContainsRune(title, 0) {
		problem(w, http.StatusBadRequest, "invalid_project_title")
		return
	}

	created := project{Title: title, Role: Owner}
	err := s.pool.QueryRow(r.Context(), `WITH created AS (INSERT INTO projects (title) VALUES ($1) RETURNING id),
 member AS (INSERT INTO memberships (project_id, account_id, role) SELECT id, $2, 'owner' FROM created RETURNING project_id)
 INSERT INTO web_activity(project_id, actor_id, action, subject_id) SELECT project_id, $2, 'project.created', project_id FROM member
 RETURNING project_id::text`, title, session.AccountID).Scan(&created.ID)
	if err != nil {
		internal(w, "create_project", err)
		return
	}

	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) listMembers(w http.ResponseWriter, r *http.Request, session Session) {
	projectID := r.PathValue("project")
	role, err := readRole(r.Context(), s.pool, projectID, session.AccountID)
	if !requireRole(w, role, err, role.valid()) {
		return
	}

	rows, err := s.pool.Query(r.Context(), `SELECT a.id::text AS account_id, a.email, m.role
 FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.project_id = $1
 AND EXISTS (SELECT 1 FROM memberships WHERE project_id = $1 AND account_id = $2) ORDER BY a.email`,
		projectID, session.AccountID)
	if err != nil {
		internal(w, "list_members", err)
		return
	}

	members, err := pgx.CollectRows(rows, pgx.RowToStructByName[member])
	if err != nil {
		internal(w, "read_members", err)
		return
	}

	writeJSON(w, http.StatusOK, members)
}

func lockProject(ctx context.Context, tx pgx.Tx, projectID string) error {
	if !uuidPattern.MatchString(projectID) {
		return pgx.ErrNoRows
	}

	var id string
	return tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id = $1 FOR NO KEY UPDATE`, projectID).Scan(&id)
}

func (s *Server) changeMember(w http.ResponseWriter, r *http.Request, session Session) {
	projectID, accountID := r.PathValue("project"), r.PathValue("account")
	if !uuidPattern.MatchString(accountID) {
		problem(w, http.StatusNotFound, "member_not_found")
		return
	}

	var input struct {
		Role Role `json:"role"`
	}
	if r.Method == http.MethodPatch {
		if !readJSON(w, r, &input) {
			return
		}
		if !input.Role.valid() {
			problem(w, http.StatusBadRequest, "invalid_project_role")
			return
		}
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		internal(w, "change_member", err)
		return
	}
	defer tx.Rollback(ctx)

	if err := lockProject(ctx, tx, projectID); err != nil {
		requireRole(w, "", err, false)
		return
	}
	callerRole, err := readRole(ctx, tx, projectID, session.AccountID)
	if !requireRole(w, callerRole, err, callerRole == Owner) {
		return
	}

	if !requireActiveProject(w, ctx, tx, projectID) {
		return
	}

	targetRole, err := readRole(ctx, tx, projectID, accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, http.StatusNotFound, "member_not_found")
		return
	}
	if err != nil {
		internal(w, "read_target_role", err)
		return
	}

	if targetRole == Owner && input.Role != Owner {
		var otherOwner bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM memberships
  WHERE project_id = $1 AND account_id <> $2 AND role = 'owner')`, projectID, accountID).Scan(&otherOwner)
		if err != nil {
			internal(w, "count_project_owners", err)
			return
		}
		if !otherOwner {
			problem(w, http.StatusConflict, "last_owner")
			return
		}
	}

	if r.Method == http.MethodDelete {
		_, err = tx.Exec(ctx, `DELETE FROM memberships WHERE project_id = $1 AND account_id = $2`, projectID, accountID)
	} else {
		_, err = tx.Exec(ctx, `UPDATE memberships SET role = $3 WHERE project_id = $1 AND account_id = $2`, projectID, accountID, input.Role)
	}
	if err != nil {
		internal(w, "write_membership", err)
		return
	}
	if r.Method == http.MethodDelete || input.Role == Reviewer {
		_, err := tx.Exec(ctx, `WITH changed AS (
 UPDATE web_tasks SET assignee_id=NULL,revision=revision+1 WHERE project_id=$1 AND assignee_id=$2 RETURNING id
 )
 INSERT INTO web_activity(project_id,actor_id,action,subject_id)
 SELECT $1,$3,'task.unassigned',id FROM changed`, projectID, accountID, session.AccountID)
		if err != nil {
			internal(w, "unassign_member_tasks", err)
			return
		}
	}
	if err := appendWebActivity(ctx, tx, projectID, session.AccountID, "membership.changed", accountID,
		map[string]any{"role": input.Role, "removed": r.Method == http.MethodDelete}); err != nil {
		internal(w, "record_membership_change", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		internal(w, "commit_membership", err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
