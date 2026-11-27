package collaboration

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	errInvitationRequired    = errors.New("invitation required")
	errInvitationRejected    = errors.New("invitation rejected")
	errIdentityEmailConflict = errors.New("email already registered")
)

func (s *Server) admitAccount(ctx context.Context, who identity, inviteHash []byte, publicSignup bool) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	// Serialize account admission across identities so simultaneous first logins and invitations have a single winner.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(814735202)`); err != nil {
		return "", err
	}

	var projectID, invitedOrganization string
	var role Role
	if inviteHash != nil && s.logto != nil {
		invitedOrganization, err = readInvitedWorkspace(ctx, tx, inviteHash, who.Email)
		if err != nil {
			return "", err
		}
	}

	if inviteHash != nil && invitedOrganization == "" {
		err := tx.QueryRow(ctx, `SELECT project_id::text FROM invitations WHERE token_hash=$1`, inviteHash).Scan(&projectID)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errInvitationRejected
		}
		if err != nil {
			return "", err
		}
		if err := lockProject(ctx, tx, projectID); err != nil {
			return "", err
		}
		err = tx.QueryRow(ctx, `SELECT role FROM invitations
  WHERE token_hash=$1 AND email=$2 AND expires_at>now() AND accepted_by IS NULL AND revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM projects p WHERE p.id=invitations.project_id AND p.archived_at IS NULL)
  FOR UPDATE`, inviteHash, who.Email).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errInvitationRejected
		}
		if err != nil {
			return "", err
		}
	}

	var accountID string
	err = tx.QueryRow(ctx, `SELECT id::text FROM accounts a WHERE (issuer = $1 AND subject = $2)
 OR EXISTS(SELECT 1 FROM account_identities i WHERE i.account_id=a.id AND i.issuer=$1 AND i.subject=$2)`,
		who.Issuer, who.Subject).Scan(&accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		var bootstrap bool
		if who.Email == s.config.BootstrapEmail {
			err = tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM accounts WHERE operator)`).Scan(&bootstrap)
			if err != nil {
				return "", err
			}
		}
		organizationMember := false
		if s.logto != nil && projectID == "" && invitedOrganization == "" && !publicSignup {
			organizations, err := s.logto.organizations(ctx, who.Subject)
			if err != nil {
				return "", err
			}
			ids := make([]string, 0, len(organizations))
			for _, organization := range organizations {
				ids = append(ids, organization.ID)
			}
			if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM workspaces WHERE active AND organization_id=ANY($1::text[]))", ids).Scan(&organizationMember); err != nil {
				return "", err
			}
		}
		if !bootstrap && projectID == "" && !organizationMember && invitedOrganization == "" && !publicSignup {
			return "", errInvitationRequired
		}

		err = tx.QueryRow(ctx, `INSERT INTO accounts (issuer, subject, email, operator, display_name) VALUES ($1, $2, $3, $4, NULLIF($5, ''))
  RETURNING id::text`, who.Issuer, who.Subject, who.Email, bootstrap, who.Name).Scan(&accountID)
	} else if err == nil {
		_, err = tx.Exec(ctx, `UPDATE accounts SET email = $2 WHERE id = $1 AND email <> $2`, accountID, who.Email)
	}

	var constraint *pgconn.PgError
	if errors.As(err, &constraint) && constraint.ConstraintName == "accounts_email_key" {
		return "", errIdentityEmailConflict
	}
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO account_identities(issuer,subject,account_id) VALUES($1,$2,$3)
 ON CONFLICT(issuer,subject) DO NOTHING`, who.Issuer, who.Subject, accountID); err != nil {
		return "", err
	}

	if publicSignup {
		if _, err := tx.Exec(ctx, `INSERT INTO workspaces(id,requested_name,created_by,active,personal)
 VALUES(gen_random_uuid(),'내 작업실',$1,true,true) ON CONFLICT (created_by) WHERE personal DO NOTHING`, accountID); err != nil {
			return "", err
		}
	}

	if invitedOrganization != "" {
		if err := s.logto.ensureMember(ctx, invitedOrganization, who.Subject, "samtdi-member"); err != nil {
			return "", err
		}
		if err := s.logto.ensureRole(ctx, invitedOrganization, who.Subject, "samtdi-member"); err != nil {
			return "", err
		}
		if _, err := tx.Exec(ctx, "UPDATE workspace_invitations SET accepted_by=$2 WHERE token_hash=$1 AND accepted_by IS NULL", inviteHash, accountID); err != nil {
			return "", err
		}
	}

	if projectID != "" {
		if s.logto != nil {
			var organization string
			if err := tx.QueryRow(ctx, `SELECT COALESCE(w.organization_id,'') FROM projects p
 LEFT JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1`, projectID).Scan(&organization); err != nil {
				return "", err
			}
			if organization != "" {
				if err := s.logto.ensureMember(ctx, organization, who.Subject, "samtdi-guest"); err != nil {
					return "", err
				}
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO memberships (project_id, account_id, role) VALUES ($1, $2, $3)
  ON CONFLICT (project_id, account_id) DO NOTHING`, projectID, accountID, role); err != nil {
			return "", err
		}
		if _, err := tx.Exec(ctx, `UPDATE invitations SET accepted_by = $2 WHERE token_hash = $1`, inviteHash, accountID); err != nil {
			return "", err
		}
		if err := appendWebActivity(ctx, tx, projectID, accountID, "invitation.accepted", accountID, nil); err != nil {
			return "", err
		}
	}

	return accountID, tx.Commit(ctx)
}
