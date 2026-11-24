package collaboration

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maintenanceKey int64 = 814735203

func AcquireMaintenance(ctx context.Context, pool *pgxpool.Pool, exclusive bool) (func(), error) {
	conn, err := pgx.ConnectConfig(ctx, pool.Config().ConnConfig)
	if err != nil {
		return nil, errors.New("maintenance database connection failed")
	}

	closeConnection := func() {
		closeContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = conn.Close(closeContext)
	}
	query := `SELECT pg_try_advisory_lock_shared($1)`
	if exclusive {
		query = `SELECT pg_try_advisory_lock($1)`
	}

	var locked bool
	if err := conn.QueryRow(ctx, query, maintenanceKey).Scan(&locked); err != nil || !locked {
		closeConnection()
		return nil, errors.New("collaboration service or maintenance is already running")
	}

	return closeConnection, nil
}

type MaintenanceConfig struct {
	Git               GitConfig
	S3                S3Config
	AllowLoopbackHTTP bool
}

func RunMaintenance(ctx context.Context, pool *pgxpool.Pool, settings MaintenanceConfig, action, folder string) error {
	release, err := AcquireMaintenance(ctx, pool, true)
	if err != nil {
		return err
	}
	defer release()

	if err := Migrate(ctx, pool); err != nil {
		return errors.New("maintenance schema migration failed")
	}
	blobs, err := newS3Store(ctx, settings.S3, settings.AllowLoopbackHTTP)
	if err != nil {
		return err
	}
	if action == "rebuild-waveforms" {
		return rebuildWebWaveforms(ctx, pool, blobs)
	}

	var git *GitRepositories
	if settings.Git != (GitConfig{}) {
		git, err = NewGitRepositories(ctx, settings.Git)
		if err != nil {
			return err
		}
	}

	state := snapshotState{pool: pool, git: git, blobs: blobs}
	switch action {
	case "snapshot":
		return state.snapshot(ctx, folder)
	case "restore":
		return state.restore(ctx, folder)
	default:
		return errors.New("unknown maintenance command")
	}
}
