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
	if err := tx.Commit(ctx); err != nil {
		internal(w, "commit_invite", err)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "expires_at": expires, "accept_url": s.origin + "/v1/auth/login?invite=" + url.QueryEscape(token),
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
