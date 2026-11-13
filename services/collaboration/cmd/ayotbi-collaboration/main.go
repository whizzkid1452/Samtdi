package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/whizzkid1452/Samtdi/services/collaboration"
)

func main() {
	if filepath.Base(os.Args[0]) == "pre-receive" {
		if err := collaboration.RunReceiveHook(context.Background(), os.Stdin, os.Stderr); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		return
	}

	if len(os.Args) == 3 && (os.Args[1] == "snapshot" || os.Args[1] == "restore") {
		if err := maintenance(os.Args[1], os.Args[2]); err != nil {
			slog.Error("collaboration maintenance failed", "reason", err.Error())
			os.Exit(1)
		}
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "media-worker" {
		if err := mediaWorker(); err != nil {
			slog.Error("media worker stopped", "reason", err.Error())
			os.Exit(1)
		}
		return
	}
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: ayotbi-collaboration [media-worker|snapshot <folder>|restore <folder>]")
		os.Exit(2)
	}

	if err := run(); err != nil {
		slog.Error("collaboration service stopped", "reason", err.Error())
		os.Exit(1)
	}
}

func storageSettings() collaboration.MaintenanceConfig {
	return collaboration.MaintenanceConfig{
		Git:               collaboration.GitConfig{Root: os.Getenv("AYOTBI_GIT_ROOT"), Executable: os.Getenv("AYOTBI_GIT_EXECUTABLE")},
		S3:                collaboration.S3Config{Bucket: os.Getenv("AYOTBI_S3_BUCKET"), Region: os.Getenv("AYOTBI_S3_REGION"), Endpoint: os.Getenv("AYOTBI_S3_ENDPOINT")},
		AllowLoopbackHTTP: os.Getenv("AYOTBI_ALLOW_LOOPBACK_HTTP") == "1",
	}
}

func maintenance(action, folder string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := openDatabase(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := collaboration.RunMaintenance(ctx, pool, storageSettings(), action, folder); err != nil {
		return err
	}
	slog.Info("collaboration maintenance complete", "action", action)
	return nil
}

func openDatabase(ctx context.Context) (*pgxpool.Pool, error) {
	dsn := os.Getenv("AYOTBI_DATABASE_URL")
	if dsn == "" {
		return nil, errors.New("AYOTBI_DATABASE_URL is required")
	}

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, errors.New("invalid database configuration")
	}

	return pool, nil
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	pool, err := openDatabase(startup)
	if err != nil {
		return err
	}
	defer pool.Close()
	release, err := collaboration.AcquireMaintenance(startup, pool, false)
	if err != nil {
		return err
	}
	defer release()

	if err := collaboration.Migrate(startup, pool); err != nil {
		return errors.New("database migration failed")
	}

	address := os.Getenv("AYOTBI_LISTEN")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return errors.New("AYOTBI_LISTEN must bind to a loopback IP behind the TLS proxy")
	}

	executable, err := os.Executable()
	if err != nil {
		return errors.New("service executable path unavailable")
	}

	storage := storageSettings()
	handler, err := collaboration.NewServer(startup, pool, collaboration.Config{
		Origin: os.Getenv("AYOTBI_ORIGIN"), Issuer: os.Getenv("AYOTBI_OIDC_ISSUER"),
		ClientID: os.Getenv("AYOTBI_OIDC_CLIENT_ID"), ClientSecret: os.Getenv("AYOTBI_OIDC_CLIENT_SECRET"),
		BootstrapEmail: os.Getenv("AYOTBI_BOOTSTRAP_EMAIL"), AllowLoopbackHTTP: storage.AllowLoopbackHTTP,
		ProjectToolPath:       os.Getenv("AYOTBI_PROJECT_TOOL"),
		ReceiveHookExecutable: executable,
		Renderer:              collaboration.RendererConfig{Executable: os.Getenv("AYOTBI_RENDER_WORKER"), PluginRegistry: os.Getenv("AYOTBI_RENDER_PLUGIN_REGISTRY")},
		Git:                   storage.Git,
		S3:                    storage.S3,
	})
	if err != nil {
		return err
	}

	defer handler.Close()
	renderContext, stopRenderer := context.WithCancel(ctx)
	rendererDone := make(chan struct{})
	go func() { defer close(rendererDone); handler.RunReviewRenderer(renderContext) }()
	defer func() { stopRenderer(); <-rendererDone }()

	server := &http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 32 << 10}
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	slog.Info("collaboration service listening", "address", address)

	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		shutdown, finish := context.WithTimeout(context.Background(), 10*time.Second)
		defer finish()
		return server.Shutdown(shutdown)
	}
}

func mediaWorker() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := openDatabase(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()
	settings := storageSettings()
	return collaboration.RunWebMediaWorker(ctx, pool, settings.S3, settings.AllowLoopbackHTTP)
}
