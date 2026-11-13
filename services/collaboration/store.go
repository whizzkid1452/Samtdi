package collaboration

import (
	"context"
	"embed"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(814735201)`); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS collaboration_migrations (name text PRIMARY KEY)`); err != nil {
		return err
	}

	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}

	for _, entry := range entries {
		var applied bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaboration_migrations WHERE name = $1)`, entry.Name()).Scan(&applied)
		if err != nil {
			return err
		}
		if applied {
			continue
		}

		sql, err := migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql), pgx.QueryExecModeSimpleProtocol); err != nil {
			return fmt.Errorf("migration %s: %w", entry.Name(), err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO collaboration_migrations VALUES ($1)`, entry.Name()); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}
