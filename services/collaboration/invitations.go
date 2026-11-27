package collaboration

import (
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) invite(w http.ResponseWriter, r *http.Request, session Session) {
	var input struct {
		Email string `json:"email"`
		Role  Role   `json:"role"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	email, err := verifiedEmail(input.Email)
	if err != nil || !input.Role.valid() {
		problem(w, http.StatusBadRequest, "invalid_invitation")
		return
	}

	ctx := r.Context()
	projectID := r.PathValue("project")
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		internal(w, "create_invite", err)
		return
	}
	defer tx.Rollback(ctx)

	if err := lockProject(ctx, tx, projectID); err != nil {
		requireRole(w, "", err, false)
		return
	}
	role, err := readRole(ctx, tx, projectID, session.AccountID)
	if !requireRole(w, role, err, role == Owner) {
		return
	}

	if !requireActiveProject(w, ctx, tx, projectID) {
		return
	}

	token := randomToken()
	var id string
	var expires time.Time
	err = tx.QueryRow(ctx, `INSERT INTO invitations (token_hash, project_id, email, role, expires_at)
 VALUES ($1, $2, $3, $4, now() + interval '7 days') RETURNING id::text, expires_at`,
		tokenHash(token), projectID, email, input.Role).Scan(&id, &expires)
	if err != nil {
		internal(w, "insert_invite", err)
		return
	}
	if err := appendWebActivity(ctx, tx, projectID, session.AccountID, "invitation.created", id, nil); err != nil {
		internal(w, "record_invitation", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		internal(w, "commit_invite", err)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "expires_at": expires, "preview_url": s.origin + "/invite/" + token, "accept_url": s.origin + "/v1/auth/login?invite=" + url.QueryEscape(token),
	})
}

func (s *Server) revokeInvite(w http.ResponseWriter, r *http.Request, session Session) {
	projectID, inviteID := r.PathValue("project"), r.PathValue("invite")
	if !uuidPattern.MatchString(inviteID) {
		problem(w, http.StatusNotFound, "invitation_not_found")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		internal(w, "revoke_invite", err)
		return
	}
	defer tx.Rollback(ctx)

	if err := lockProject(ctx, tx, projectID); err != nil {
		requireRole(w, "", err, false)
		return
	}
	role, err := readRole(ctx, tx, projectID, session.AccountID)
	if !requireRole(w, role, err, role == Owner) {
		return
	}

	var revoked string
	err = tx.QueryRow(ctx, `UPDATE invitations SET revoked_at = now()
 WHERE id = $1 AND project_id = $2 AND accepted_by IS NULL RETURNING id::text`, inviteID, projectID).Scan(&revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, http.StatusNotFound, "invitation_not_found")
		return
	}
	if err != nil {
		internal(w, "update_invitation", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		internal(w, "commit_invite_revoke", err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

type webInvitationPreview struct {
	Title    string `json:"title"`
	Kind     string `json:"kind"`
	Role     string `json:"role"`
	ReturnTo string `json:"return_to"`
}

func (s *Server) webInvitationPreview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	token := r.PathValue("token")
	if !tokenPattern.MatchString(token) {
		problem(w, http.StatusNotFound, "invitation_not_found")
		return
	}

	var preview webInvitationPreview
	var projectID string
	hash := tokenHash(token)
	err := s.pool.QueryRow(r.Context(), `SELECT p.id::text,p.title,i.role::text
 FROM invitations i JOIN projects p ON p.id=i.project_id WHERE i.token_hash=$1 AND i.expires_at>now()
 AND i.accepted_by IS NULL AND i.revoked_at IS NULL AND p.archived_at IS NULL`, hash).
		Scan(&projectID, &preview.Title, &preview.Role)
	if err == nil {
		preview.Kind = "project"
		preview.ReturnTo = "/projects/" + projectID + "/media"
	} else if errors.Is(err, pgx.ErrNoRows) && s.workspacesEnabled() {
		var workspaceID string
		err = s.pool.QueryRow(r.Context(), `SELECT w.id::text,w.requested_name
 FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_hash=$1 AND i.expires_at>now()
 AND i.accepted_by IS NULL AND i.revoked_at IS NULL AND w.active AND NOT w.personal`, hash).
			Scan(&workspaceID, &preview.Title)
		preview.Kind, preview.Role = "workspace", "member"
		preview.ReturnTo = "/projects?workspace=" + workspaceID
	}

	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, http.StatusNotFound, "invitation_not_found")
		return
	}
	if err != nil {
		internal(w, "preview_invitation", err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}
