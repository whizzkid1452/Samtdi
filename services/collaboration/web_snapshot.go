package collaboration

import (
	"context"
	"errors"
	"io"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

func snapshotPendingUploads(ctx context.Context, db rowsQuerier) ([]snapshotObject, error) {
	return collectSnapshotRows(ctx, db, `SELECT 'web/incoming/'||u.project_id::text||'/'||u.id::text,u.bytes
 FROM web_uploads u JOIN web_media_jobs j ON j.version_id=u.id WHERE j.finished_at IS NULL ORDER BY u.id`,
		func(row pgx.CollectableRow) (snapshotObject, error) {
			var item snapshotObject
			err := row.Scan(&item.Key, &item.Bytes)
			return item, err
		})
}

func (state snapshotState) snapshotPendingBlob(ctx context.Context, root string, object snapshotObject) (snapshotObject, error) {
	object.SHA256 = strings.Repeat("0", 64)
	if !validSnapshotObject(object) {
		return snapshotObject{}, errors.New("invalid pending media index")
	}
	body, meta, err := state.blobs.Open(ctx, object.Key)
	if err != nil {
		return snapshotObject{}, err
	}
	defer body.Close()
	if meta.Size != object.Bytes {
		return snapshotObject{}, errors.New("pending media size changed")
	}
	file, err := writeSnapshotFile(root, objectPath(object), func(w io.Writer) error {
		_, err := io.Copy(w, io.LimitReader(body, object.Bytes+1))
		return err
	})
	if err != nil {
		return snapshotObject{}, err
	}
	if file.Bytes != object.Bytes {
		return snapshotObject{}, errors.New("incomplete pending media")
	}
	object.SHA256 = file.SHA256
	return object, nil
}

func validateWebRestoreIndex(ctx context.Context, tx pgx.Tx, manifest []snapshotObject) error {
	objects, err := snapshotObjects(ctx, tx)
	if err != nil {
		return err
	}
	pending, err := snapshotPendingUploads(ctx, tx)
	if err != nil {
		return err
	}
	hashes := make(map[string]string, len(manifest))
	for _, object := range manifest {
		hashes[object.Key] = object.SHA256
	}
	for _, item := range pending {
		item.SHA256 = hashes[item.Key]
		objects = append(objects, item)
	}
	sort.Slice(objects, func(i, j int) bool { return objects[i].Key < objects[j].Key })
	if !equalObjects(objects, manifest) {
		return errors.New("snapshot object index does not match the database")
	}
	return nil
}

func restoreWebState(ctx context.Context, tx pgx.Tx) error {
	queries := []string{
		"ALTER TABLE web_activity ENABLE TRIGGER web_activity_notification",
		"SELECT setval(pg_get_serial_sequence('web_activity','id'),COALESCE(max(id),1),count(*)>0) FROM web_activity",
		"SELECT setval(pg_get_serial_sequence('web_note_edits','id'),COALESCE(max(id),1),count(*)>0) FROM web_note_edits",
		"UPDATE web_media_jobs SET leased_until=NULL,lease_id=NULL,available_at=now() WHERE finished_at IS NULL",
		"UPDATE web_media_versions SET state='queued' WHERE state='processing'",
		"UPDATE web_uploads SET expires_at=LEAST(expires_at,now()),cleaned_at=now() WHERE completion_key IS NULL",
	}
	for _, query := range queries {
		if _, err := tx.Exec(ctx, query); err != nil {
			return err
		}
	}
	return nil
}
