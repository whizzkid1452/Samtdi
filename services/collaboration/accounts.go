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

func (s *Server) admitAccount(ctx context.Context, who identity, inviteHash []byte) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	// Serialize account admission across identities so simultaneous first logins and invitations have a single winner.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(814735202)`); err != nil {
		return "", err
	}

	var projectID string
	var role Role
	if inviteHash != nil {
		err := tx.QueryRow(ctx, `SELECT project_id::text, role FROM invitations
  WHERE token_hash = $1 AND email = $2 AND expires_at > now() AND accepted_by IS NULL AND revoked_at IS NULL
  FOR UPDATE`, inviteHash, who.Email).Scan(&projectID, &role)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errInvitationRejected
		}
		if err != nil {
			return "", err
		}
	}

	var accountID string
	err = tx.QueryRow(ctx, `SELECT id::text FROM accounts WHERE issuer = $1 AND subject = $2`,
		who.Issuer, who.Subject).Scan(&accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		var bootstrap bool
		if who.Email == s.config.BootstrapEmail {
			err = tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM accounts WHERE operator)`).Scan(&bootstrap)
			if err != nil {
				return "", err
			}
		}
		if !bootstrap && projectID == "" {
			return "", errInvitationRequired
		}

		err = tx.QueryRow(ctx, `INSERT INTO accounts (issuer, subject, email, operator) VALUES ($1, $2, $3, $4)
  RETURNING id::text`, who.Issuer, who.Subject, who.Email, bootstrap).Scan(&accountID)
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

	if projectID != "" {
		if _, err := tx.Exec(ctx, `INSERT INTO memberships (project_id, account_id, role) VALUES ($1, $2, $3)
  ON CONFLICT (project_id, account_id) DO NOTHING`, projectID, accountID, role); err != nil {
			return "", err
		}
		if _, err := tx.Exec(ctx, `UPDATE invitations SET accepted_by = $2 WHERE token_hash = $1`, inviteHash, accountID); err != nil {
			return "", err
		}
	}

	return accountID, tx.Commit(ctx)
}
