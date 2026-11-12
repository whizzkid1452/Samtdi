package collaboration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var snapshotTables = []string{"accounts", "projects", "memberships", "invitations", "lfs_objects",
	"reviews", "review_comments", "review_media_versions"}

const snapshotManifestLimit = 32 << 20

type snapshotState struct {
	pool  *pgxpool.Pool
	git   *GitRepositories
	blobs BlobStore
}

type snapshotFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type snapshotRepository struct {
	ProjectID string        `json:"project_id"`
	Refs      string        `json:"refs"`
	Bundle    *snapshotFile `json:"bundle,omitempty"`
}

type snapshotObject struct {
	Key    string `json:"key"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type snapshotManifest struct {
	Version      int                  `json:"version"`
	CreatedAt    time.Time            `json:"created_at"`
	Schema       []string             `json:"schema"`
	Tables       []snapshotFile       `json:"tables"`
	Repositories []snapshotRepository `json:"repositories"`
	Objects      []snapshotObject     `json:"objects"`
}

type rowsQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func collectSnapshotRows[T any](ctx context.Context, db rowsQuerier, query string, scan func(pgx.CollectableRow) (T, error)) ([]T, error) {
	rows, err := db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scan)
}

func snapshotSchema(ctx context.Context, db rowsQuerier) ([]string, error) {
	return collectSnapshotRows(ctx, db, `SELECT name FROM collaboration_migrations ORDER BY name`, pgx.RowTo[string])
}

func snapshotProjectIDs(ctx context.Context, db rowsQuerier) ([]string, error) {
	return collectSnapshotRows(ctx, db, `SELECT id::text FROM projects ORDER BY id`, pgx.RowTo[string])
}

func snapshotObjects(ctx context.Context, db rowsQuerier) ([]snapshotObject, error) {
	return collectSnapshotRows(ctx, db, `SELECT 'lfs/' || project_id::text || '/' || left(oid,2) || '/' || oid AS key, oid, size FROM lfs_objects
 UNION
 SELECT 'review-media/' || r.project_id::text || '/' || m.review_id::text || '/' || m.mix_oid, m.mix_oid, m.mix_bytes
 FROM review_media_versions m JOIN reviews r ON r.id = m.review_id WHERE m.state = 'ready' ORDER BY 1`,
		func(row pgx.CollectableRow) (snapshotObject, error) {
			var value snapshotObject
			err := row.Scan(&value.Key, &value.SHA256, &value.Bytes)
			return value, err
		})
}

func (state snapshotState) snapshot(ctx context.Context, folder string) error {
	root, err := filepath.Abs(folder)
	if err != nil {
		return err
	}
	if err := os.Mkdir(root, 0700); err != nil {
		return errors.New("snapshot output must be a new directory")
	}

	published := false
	defer func() {
		if !published {
			_ = os.RemoveAll(root)
		}
	}()
	manifest := snapshotManifest{Version: 1, CreatedAt: time.Now().UTC()}

	tx, err := state.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	manifest.Schema, err = snapshotSchema(ctx, tx)
	if err != nil {
		return err
	}
	projectIDs, err := snapshotProjectIDs(ctx, tx)
	if err != nil {
		return err
	}
	manifest.Objects, err = snapshotObjects(ctx, tx)
	if err != nil {
		return err
	}

	for _, table := range snapshotTables {
		file, err := writeSnapshotFile(root, filepath.Join("db", table+".copy"), func(output io.Writer) error {
			_, err := tx.Conn().PgConn().CopyTo(ctx, output, "COPY "+table+" TO STDOUT (FORMAT binary)")
			return err
		})
		if err != nil {
			return err
		}
		manifest.Tables = append(manifest.Tables, file)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	for _, id := range projectIDs {
		repository := filepath.Join(state.git.root, id+".git")
		exists, err := bareRepository(repository)
		if err != nil {
			return err
		}
		if !exists {
			continue
		}

		refs, err := snapshotRefs(ctx, state.git, repository)
		if err != nil {
			return err
		}
		saved := snapshotRepository{ProjectID: id, Refs: refs}
		if refs != "" {
			name := filepath.Join("git", id+".bundle")
			if err := os.MkdirAll(filepath.Join(root, "git"), 0700); err != nil {
				return err
			}
			destination := filepath.Join(root, name)
			if _, err := state.git.run(ctx, repository, "bundle", "create", destination, "--all"); err != nil {
				return err
			}
			metadata, err := inspectSnapshotFile(root, name)
			if err != nil {
				return err
			}
			saved.Bundle = &metadata
		}
		manifest.Repositories = append(manifest.Repositories, saved)
	}

	for _, object := range manifest.Objects {
		if err := state.snapshotBlob(ctx, root, object); err != nil {
			return err
		}
	}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil || len(encoded) > snapshotManifestLimit {
		return errors.New("snapshot manifest too large")
	}
	if _, err := writeSnapshotFile(root, "manifest.json", func(output io.Writer) error {
		_, err := output.Write(encoded)
		return err
	}); err != nil {
		return err
	}

	published = true
	return nil
}

func (state snapshotState) snapshotBlob(ctx context.Context, root string, object snapshotObject) error {
	if !validSnapshotObject(object) {
		return errors.New("invalid snapshot object index")
	}

	stream, metadata, err := state.blobs.Open(ctx, object.Key)
	if err != nil {
		return err
	}
	defer stream.Close()
	if metadata.Size != object.Bytes || metadata.SHA256 != object.SHA256 {
		return errors.New("snapshot object metadata mismatch")
	}

	saved, err := writeSnapshotFile(root, objectPath(object), func(output io.Writer) error {
		_, err := io.Copy(output, io.LimitReader(stream, object.Bytes+1))
		return err
	})
	if err != nil {
		return err
	}
	if saved.Bytes != object.Bytes || saved.SHA256 != object.SHA256 {
		return errors.New("snapshot object checksum mismatch")
	}

	return nil
}

func (state snapshotState) restore(ctx context.Context, folder string) error {
	root, err := filepath.Abs(folder)
	if err != nil {
		return err
	}
	manifest, err := readSnapshot(root)
	if err != nil {
		return err
	}

	tx, err := state.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	schema, err := snapshotSchema(ctx, tx)
	if err != nil || !reflect.DeepEqual(schema, manifest.Schema) {
		return errors.New("snapshot schema does not match")
	}

	var populated bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM accounts) OR EXISTS(SELECT 1 FROM projects)`).Scan(&populated); err != nil {
		return err
	}
	if populated {
		return errors.New("restore requires an empty collaboration database")
	}

	for index, table := range snapshotTables {
		file, err := os.Open(filepath.Join(root, manifest.Tables[index].Path))
		if err != nil {
			return err
		}
		_, err = tx.Conn().PgConn().CopyFrom(ctx, file, "COPY "+table+" FROM STDIN (FORMAT binary)")
		if err := errors.Join(err, file.Close()); err != nil {
			return err
		}
	}
	objects, err := snapshotObjects(ctx, tx)
	if err != nil || len(objects) != len(manifest.Objects) || !equalObjects(objects, manifest.Objects) {
		return errors.New("snapshot object index does not match the database")
	}
	projectIDs, err := snapshotProjectIDs(ctx, tx)
	if err != nil {
		return err
	}

	if err := state.restoreRepositories(ctx, root, manifest.Repositories, projectIDs); err != nil {
		return err
	}
	for _, object := range manifest.Objects {
		if err := state.restoreBlob(ctx, root, object); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(ctx, `UPDATE invitations SET revoked_at = now() WHERE accepted_by IS NULL AND revoked_at IS NULL`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE review_media_versions SET state = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
 lease_id = NULL, lease_until = NULL WHERE state = 'running'`); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

func (state snapshotState) restoreRepositories(ctx context.Context, root string, repositories []snapshotRepository, projectIDs []string) error {
	projectSet := make(map[string]bool, len(projectIDs))
	for _, id := range projectIDs {
		projectSet[id] = true
	}
	archiveSet := make(map[string]bool, len(repositories))
	for _, repository := range repositories {
		if !projectSet[repository.ProjectID] || archiveSet[repository.ProjectID] {
			return errors.New("unexpected archived repository")
		}
		archiveSet[repository.ProjectID] = true
	}
	entries, err := os.ReadDir(state.git.root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		id, ok := strings.CutSuffix(entry.Name(), ".git")
		if !ok || !archiveSet[id] {
			return errors.New("restore repository root contains unrelated files")
		}
	}

	for _, saved := range repositories {
		repository, err := state.git.repository(ctx, saved.ProjectID)
		if err != nil {
			return err
		}
		current, err := snapshotRefs(ctx, state.git, repository)
		if err != nil {
			return err
		}
		if current == saved.Refs {
			if _, err := state.git.run(ctx, repository, "fsck", "--strict"); err != nil {
				return err
			}
			continue
		}
		if current != "" || saved.Bundle == nil {
			return errors.New("restore would replace an existing repository")
		}

		bundle := filepath.Join(root, saved.Bundle.Path)
		if _, err := state.git.run(ctx, repository, "bundle", "verify", bundle); err != nil {
			return err
		}
		if _, err := state.git.run(ctx, repository, "fetch", "--atomic", "--no-tags", "--no-write-fetch-head", bundle, "+refs/*:refs/*"); err != nil {
			return err
		}
		restored, err := snapshotRefs(ctx, state.git, repository)
		if err != nil || restored != saved.Refs {
			return errors.New("restored Git references differ")
		}
		if _, err := state.git.run(ctx, repository, "fsck", "--strict"); err != nil {
			return err
		}
	}
	return nil
}

func (state snapshotState) restoreBlob(ctx context.Context, root string, object snapshotObject) error {
	expected := BlobMetadata{Size: object.Bytes, SHA256: object.SHA256}
	actual, err := state.blobs.Head(ctx, object.Key)
	if err == nil {
		if actual != expected {
			return errors.New("restore would replace a different object")
		}

		stream, metadata, err := state.blobs.Open(ctx, object.Key)
		if err != nil {
			return err
		}
		defer stream.Close()

		digest := sha256.New()
		count, err := io.Copy(digest, io.LimitReader(stream, object.Bytes+1))
		if err != nil || metadata != expected || count != object.Bytes || hex.EncodeToString(digest.Sum(nil)) != object.SHA256 {
			return errors.New("restore found a corrupt existing object")
		}
		return nil
	}
	if !errors.Is(err, errBlobMissing) {
		return err
	}

	input, err := os.Open(filepath.Join(root, objectPath(object)))
	if err != nil {
		return err
	}
	defer input.Close()

	return state.blobs.Put(ctx, object.Key, expected, input)
}
