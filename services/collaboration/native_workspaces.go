package collaboration

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

func (s *Server) nativeWorkspaces() bool  { return s.config.PublicSignup && s.logto == nil }
func (s *Server) workspacesEnabled() bool { return s.logto != nil || s.nativeWorkspaces() }

func (s *Server) listNativeWorkspaces(w http.ResponseWriter, r *http.Request, session Session) {
	rows, err := s.pool.Query(r.Context(), `SELECT w.id::text,w.requested_name,w.personal,COALESCE(m.role,'owner')
 FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.account_id=$1
 WHERE w.active AND w.organization_id IS NULL
 AND ((w.personal AND w.created_by=$1) OR (NOT w.personal AND m.account_id IS NOT NULL))
 ORDER BY w.personal DESC,w.created_at,w.id`, session.AccountID)
	if err != nil {
		internal(w, "list_workspaces", err)
		return
	}
	entries, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (workspace, error) { return scanNativeWorkspace(row) })
	if err != nil {
		internal(w, "read_workspaces", err)
		return
	}
	if entries == nil {
		entries = []workspace{}
	}
	writeJSON(w, 200, map[string]any{"enabled": true, "join_by_code": true, "workspaces": entries})
}

type workspaceScanner interface{ Scan(...any) error }

func scanNativeWorkspace(row workspaceScanner) (workspace, error) {
	entry := workspace{Active: true, CanCreate: true}
	var role string
	err := row.Scan(&entry.ID, &entry.Name, &entry.Personal, &role)
	entry.Owner = role == "owner"
	return entry, err
}

func (s *Server) readNativeWorkspace(ctx context.Context, id string, session Session, owner bool) (workspace, error) {
	entry, err := scanNativeWorkspace(s.pool.QueryRow(ctx, `SELECT w.id::text,w.requested_name,w.personal,COALESCE(m.role,'owner')
 FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id=w.id AND m.account_id=$2
 WHERE w.id=$1 AND w.active AND w.organization_id IS NULL
 AND ((w.personal AND w.created_by=$2) OR (NOT w.personal AND m.account_id IS NOT NULL))`, id, session.AccountID))
	if err != nil {
		return workspace{}, err
	}
	if owner && entry.Personal {
		return workspace{}, pgx.ErrNoRows
	}
	if owner && !entry.Owner {
		return workspace{}, webProblem{403, "workspace_owner_required"}
	}
	return entry, nil
}

func (s *Server) createNativeWorkspace(w http.ResponseWriter, r *http.Request, session Session, id, name string) {
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		internal(w, "begin_workspace", err)
		return
	}
	defer tx.Rollback(ctx)
	created, err := tx.Exec(ctx, `INSERT INTO workspaces (id,requested_name,created_by,active)
 VALUES ($1,$2,$3,true) ON CONFLICT (id) DO NOTHING`, id, name, session.AccountID)
	if err != nil {
		internal(w, "create_workspace", err)
		return
	}
	status := http.StatusCreated
	if created.RowsAffected() == 1 {
		_, err = tx.Exec(ctx, `INSERT INTO workspace_members (workspace_id,account_id,role) VALUES ($1,$2,'owner')`, id, session.AccountID)
	} else {
		status = http.StatusOK
		var matches bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
 WHERE w.id=$1 AND w.active AND NOT w.personal AND w.organization_id IS NULL AND w.requested_name=$2
 AND w.created_by=$3 AND m.account_id=$3 AND m.role='owner')`, id, name, session.AccountID).Scan(&matches)
		if err == nil && !matches {
			problem(w, 409, "workspace_request_conflict")
			return
		}
	}
	if err != nil {
		internal(w, "save_workspace_owner", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		internal(w, "commit_workspace", err)
		return
	}
	writeJSON(w, status, workspace{ID: id, Name: name, Owner: true, CanCreate: true, Active: true})
}

func (s *Server) listNativeWorkspaceMembers(w http.ResponseWriter, r *http.Request, entry workspace, page int) {
	if page > 10000 {
		problem(w, 400, "invalid_page")
		return
	}
	rows, err := s.pool.Query(r.Context(), `SELECT a.id::text,a.email,COALESCE(a.display_name,''),m.role
 FROM workspace_members m JOIN accounts a ON a.id=m.account_id WHERE m.workspace_id=$1
 ORDER BY m.role DESC,a.id LIMIT 100 OFFSET $2`, entry.ID, (page-1)*100)
	if err != nil {
		internal(w, "list_workspace_members", err)
		return
	}
	members, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (logtoUser, error) {
		var member logtoUser
		var role string
		err := row.Scan(&member.ID, &member.Email, &member.Name, &role)
		member.Roles = []organizationRole{{Name: "samtdi-" + role}}
		return member, err
	})
	if err != nil {
		internal(w, "read_workspace_members", err)
		return
	}
	if members == nil {
		members = []logtoUser{}
	}
	writeJSON(w, 200, members)
}

func (s *Server) removeNativeWorkspaceMember(w http.ResponseWriter, r *http.Request, entry workspace, accountID string) {
	if !uuidPattern.MatchString(accountID) {
		problem(w, 404, "resource_not_found")
		return
	}
	result, err := s.pool.Exec(r.Context(), `DELETE FROM workspace_members
 WHERE workspace_id=$1 AND account_id=$2 AND role='member'`, entry.ID, accountID)
	if err != nil {
		internal(w, "remove_workspace_member", err)
		return
	}
	if result.RowsAffected() == 0 {
		problem(w, 404, "resource_not_found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func readNativeWorkspaceInvitation(ctx context.Context, tx pgx.Tx, hash []byte, email string) (string, error) {
	var id string
	var eligible bool
	err := tx.QueryRow(ctx, `SELECT w.id::text, i.email=$2 AND w.active AND NOT w.personal AND w.organization_id IS NULL
 AND i.revoked_at IS NULL AND i.expires_at>now() AND i.accepted_by IS NULL
 FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id
 WHERE i.token_hash=$1 FOR UPDATE OF i`, hash, email).Scan(&id, &eligible)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !eligible {
		return "", errInvitationRejected
	}
	return id, nil
}

func acceptNativeWorkspaceInvitation(ctx context.Context, tx pgx.Tx, hash []byte, id, accountID string) error {
	if _, err := tx.Exec(ctx, `INSERT INTO workspace_members (workspace_id,account_id,role)
 VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`, id, accountID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE workspace_invitations SET accepted_by=$2 WHERE token_hash=$1`, hash, accountID)
	return err
}

func (s *Server) joinNativeWorkspace(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.nativeWorkspaces() {
		problem(w, 404, "resource_not_found")
		return
	}
	var input struct {
		Code string `json:"code"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	code := strings.TrimSpace(input.Code)
	if !tokenPattern.MatchString(code) {
		problem(w, 400, "invalid_invitation")
		return
	}
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		internal(w, "begin_workspace_join", err)
		return
	}
	defer tx.Rollback(ctx)
	hash := tokenHash(code)
	id, err := readNativeWorkspaceInvitation(ctx, tx, hash, session.Email)
	if errors.Is(err, errInvitationRejected) || (err == nil && id == "") {
		problem(w, 404, "invitation_not_found")
		return
	}
	if err == nil {
		err = acceptNativeWorkspaceInvitation(ctx, tx, hash, id, session.AccountID)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		internal(w, "accept_workspace_invitation", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"workspace_id": id})
}
