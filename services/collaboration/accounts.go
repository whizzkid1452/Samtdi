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

	invitation, err := s.lockInvitation(ctx, tx, inviteHash, who.Email)
	if err != nil {
		return "", err
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
		if s.logto != nil && invitation.empty() && !publicSignup {
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
		if !bootstrap && invitation.empty() && !organizationMember && !publicSignup {
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

	if err := s.redeemInvitation(ctx, tx, inviteHash, invitation, accountID, who.Subject); err != nil {
		return "", err
	}

	return accountID, tx.Commit(ctx)
}
