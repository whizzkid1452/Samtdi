package collaboration

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maintenanceKey int64 = 814735203

func AcquireMaintenance(ctx context.Context, pool *pgxpool.Pool, exclusive bool) (func(), error) {
	conn, err := pgx.ConnectConfig(ctx, pool.Config().ConnConfig)
	if err != nil {
		return nil, maintenanceConnectionError(err)
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

// Classify startup connection failures without logging a DSN, credential, host,
// or any raw driver/server error text.
func maintenanceConnectionError(err error) error {
	const prefix = "maintenance database connection failed: "
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "tenant or user not found") || strings.Contains(message, "role") && strings.Contains(message, "does not exist"):
		return errors.New(prefix + "pooler tenant or database role not found")
	case strings.Contains(message, "28p01") || strings.Contains(message, "password authentication failed") || strings.Contains(message, "invalid password"):
		return errors.New(prefix + "database password rejected")
	case strings.Contains(message, "28000") || strings.Contains(message, "not permitted to log in") || strings.Contains(message, "authentication"):
		return errors.New(prefix + "database authentication rejected")
	case strings.Contains(message, "x509:") || strings.Contains(message, "certificate") || strings.Contains(message, "tls:"):
		return errors.New(prefix + "TLS certificate or handshake verification failed")
	case strings.Contains(message, "no such host") || strings.Contains(message, "lookup"):
		return errors.New(prefix + "database DNS lookup failed")
	case strings.Contains(message, "timeout") || strings.Contains(message, "deadline exceeded"):
		return errors.New(prefix + "database connection timed out")
	case strings.Contains(message, "connection refused"):
		return errors.New(prefix + "database connection refused")
	case strings.Contains(message, "too many connections") || strings.Contains(message, "max client connections"):
		return errors.New(prefix + "database connection limit reached")
	case strings.Contains(message, "server error") || strings.Contains(message, "fatal:"):
		return errors.New(prefix + "database server rejected connection")
	default:
		return errors.New(prefix + "unclassified connection failure")
	}
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
