package collaboration

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

type workspaceInvitation struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	ExpiresAt time.Time `json:"expires_at"`
	Accepted  bool      `json:"accepted"`
	Expired   bool      `json:"expired"`
	Revoked   bool      `json:"revoked"`
	Code      string    `json:"code,omitempty"`
	AcceptURL string    `json:"accept_url,omitempty"`
}

func (s *Server) workspaceInvitationRoutes() {
	s.mux.HandleFunc("POST /v1/workspaces/join", s.withSession(s.joinNativeWorkspace))
	const base = "/v1/workspaces/{workspace}/invitations"
	s.mux.HandleFunc("GET "+base, s.withSession(s.listWorkspaceInvitations))
	s.mux.HandleFunc("POST "+base, s.withSession(s.createWorkspaceInvitation))
	s.mux.HandleFunc("DELETE "+base+"/{invite}", s.withSession(s.revokeWorkspaceInvitation))
}

func (s *Server) listWorkspaceInvitations(w http.ResponseWriter, r *http.Request, session Session) {
	entry, err := s.readWorkspace(r.Context(), r.PathValue("workspace"), session, true)
	if err != nil {
		writeWebError(w, "read_workspace", err)
		return
	}

	rows, err := s.pool.Query(r.Context(), `SELECT id::text,email,expires_at,accepted_by IS NOT NULL,revoked_at IS NOT NULL,expires_at<=now()
 FROM workspace_invitations WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`, entry.ID)
	if err != nil {
		internal(w, "list_workspace_invitations", err)
		return
	}

	invitations, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (workspaceInvitation, error) {
		var invite workspaceInvitation
		err := row.Scan(&invite.ID, &invite.Email, &invite.ExpiresAt, &invite.Accepted, &invite.Revoked, &invite.Expired)
		return invite, err
	})
	if err != nil {
		internal(w, "read_workspace_invitations", err)
		return
	}
	writeJSON(w, http.StatusOK, invitations)
}

func (s *Server) createWorkspaceInvitation(w http.ResponseWriter, r *http.Request, session Session) {
	entry, err := s.readWorkspace(r.Context(), r.PathValue("workspace"), session, true)
	if err != nil {
		writeWebError(w, "read_workspace", err)
		return
	}

	var input struct {
		Email string `json:"email"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	email, err := verifiedEmail(input.Email)
	if err != nil {
		problem(w, 400, "invalid_email")
		return
	}

	token := randomToken()
	invite := workspaceInvitation{Email: email, Code: token, AcceptURL: s.origin + "/invite/" + token}
	err = s.pool.QueryRow(r.Context(), `INSERT INTO workspace_invitations(workspace_id,token_hash,email,expires_at)
 VALUES($1,$2,$3,now()+interval '7 days') RETURNING id::text,expires_at`, entry.ID, tokenHash(token), email).
		Scan(&invite.ID, &invite.ExpiresAt)
	if err != nil {
		internal(w, "create_workspace_invitation", err)
		return
	}
	writeJSON(w, http.StatusCreated, invite)
}

func (s *Server) revokeWorkspaceInvitation(w http.ResponseWriter, r *http.Request, session Session) {
	entry, err := s.readWorkspace(r.Context(), r.PathValue("workspace"), session, true)
	if err != nil {
		writeWebError(w, "read_workspace", err)
		return
	}
	id := r.PathValue("invite")
	if !uuidPattern.MatchString(id) {
		problem(w, 404, "invitation_not_found")
		return
	}

	result, err := s.pool.Exec(r.Context(), `UPDATE workspace_invitations SET revoked_at=now()
 WHERE workspace_id=$1 AND id=$2 AND accepted_by IS NULL AND revoked_at IS NULL`, entry.ID, id)
	if err != nil {
		internal(w, "revoke_workspace_invitation", err)
		return
	}
	if result.RowsAffected() == 0 {
		problem(w, http.StatusNotFound, "invitation_not_found")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func readInvitedWorkspace(ctx context.Context, tx pgx.Tx, hash []byte, email string) (string, error) {
	var organization string
	var eligible bool
	err := tx.QueryRow(ctx, `SELECT COALESCE(w.organization_id,''),i.email=$2 AND w.active AND NOT w.personal AND i.revoked_at IS NULL
 AND i.expires_at>now() AND i.accepted_by IS NULL
 FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_hash=$1 FOR UPDATE OF i`, hash, email).
		Scan(&organization, &eligible)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !eligible || organization == "" {
		return "", errInvitationRejected
	}
	return organization, nil
}
