package collaboration

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type invitationGrant struct {
	projectID    string
	workspaceID  string
	organization string
	role         Role
}

func (grant invitationGrant) empty() bool {
	return grant.projectID == "" && grant.workspaceID == ""
}

func (grant invitationGrant) returnTo() string {
	if grant.workspaceID != "" {
		return "/projects?workspace=" + grant.workspaceID
	}
	return "/projects/" + grant.projectID + "/media"
}

func (s *Server) lockInvitation(ctx context.Context, tx pgx.Tx, hash []byte, email string) (invitationGrant, error) {
	var grant invitationGrant
	if hash == nil {
		return grant, nil
	}

	var err error
	if s.logto != nil {
		grant.workspaceID, grant.organization, err = readInvitedWorkspace(ctx, tx, hash, email)
	} else if s.nativeWorkspaces() {
		grant.workspaceID, err = readNativeWorkspaceInvitation(ctx, tx, hash, email)
	}
	if err != nil || grant.workspaceID != "" {
		return grant, err
	}

	err = tx.QueryRow(ctx, `SELECT project_id::text FROM invitations WHERE token_hash=$1`, hash).Scan(&grant.projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return invitationGrant{}, errInvitationRejected
	}
	if err != nil {
		return invitationGrant{}, err
	}
	if err := lockProject(ctx, tx, grant.projectID); err != nil {
		return invitationGrant{}, err
	}

	err = tx.QueryRow(ctx, `SELECT role FROM invitations
 WHERE token_hash=$1 AND email=$2 AND expires_at>now() AND accepted_by IS NULL AND revoked_at IS NULL
 AND EXISTS (SELECT 1 FROM projects p WHERE p.id=invitations.project_id AND p.archived_at IS NULL)
 FOR UPDATE`, hash, email).Scan(&grant.role)
	if errors.Is(err, pgx.ErrNoRows) {
		return invitationGrant{}, errInvitationRejected
	}
	return grant, err
}

func (s *Server) redeemInvitation(ctx context.Context, tx pgx.Tx, hash []byte, grant invitationGrant, accountID, subject string) error {
	if grant.organization != "" {
		if err := s.logto.ensureMember(ctx, grant.organization, subject, "samtdi-member"); err != nil {
			return err
		}
		if err := s.logto.ensureRole(ctx, grant.organization, subject, "samtdi-member"); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "UPDATE workspace_invitations SET accepted_by=$2 WHERE token_hash=$1 AND accepted_by IS NULL", hash, accountID)
		return err
	}
	if grant.workspaceID != "" {
		return acceptNativeWorkspaceInvitation(ctx, tx, hash, grant.workspaceID, accountID)
	}
	if grant.projectID == "" {
		return nil
	}

	if s.nativeWorkspaces() {
		var allowed bool
		err := tx.QueryRow(ctx, `SELECT p.workspace_id IS NULL OR w.personal OR (w.active AND w.organization_id IS NULL AND EXISTS
 (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w.id AND wm.account_id=$2))
 FROM projects p LEFT JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1`, grant.projectID, accountID).Scan(&allowed)
		if err != nil {
			return err
		}
		if !allowed {
			return errInvitationRejected
		}
	}

	if s.logto != nil {
		var organization string
		if err := tx.QueryRow(ctx, `SELECT COALESCE(w.organization_id,'') FROM projects p
 LEFT JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1`, grant.projectID).Scan(&organization); err != nil {
			return err
		}
		if organization != "" {
			if err := s.logto.ensureMember(ctx, organization, subject, "samtdi-guest"); err != nil {
				return err
			}
		}
	}

	if _, err := tx.Exec(ctx, `INSERT INTO memberships (project_id, account_id, role) VALUES ($1, $2, $3)
 ON CONFLICT (project_id, account_id) DO NOTHING`, grant.projectID, accountID, grant.role); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE invitations SET accepted_by = $2 WHERE token_hash = $1`, hash, accountID); err != nil {
		return err
	}
	return appendWebActivity(ctx, tx, grant.projectID, accountID, "invitation.accepted", accountID, nil)
}
