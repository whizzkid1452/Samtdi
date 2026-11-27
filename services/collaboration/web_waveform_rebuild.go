package collaboration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func rebuildWebWaveforms(ctx context.Context, pool *pgxpool.Pool, blobs BlobStore) error {
	if blobs == nil {
		return errors.New("waveform rebuild requires object storage")
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return errors.New("FFmpeg executable is required")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		return errors.New("FFprobe executable is required")
	}
	worker := webMediaWorker{pool: pool, ffmpeg: ffmpeg, ffprobe: ffprobe}

	for {
		var version, oldKey string
		var duration int64
		var playback webArtifact
		err := pool.QueryRow(ctx, `SELECT id::text,duration_ms,playback_key,playback_bytes,playback_hash,peaks_key
 FROM web_media_versions WHERE state='ready' AND peaks_revision=1 AND duration_ms>0 AND playback_key IS NOT NULL AND peaks_key IS NOT NULL
 ORDER BY id LIMIT 1`).Scan(&version, &duration, &playback.key, &playback.size, &playback.digest, &oldKey)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := worker.rebuildWaveform(ctx, blobs, version, playback, duration, oldKey); err != nil {
			return fmt.Errorf("rebuild waveform for %s: %w", version, err)
		}
	}
}

func (w webMediaWorker) rebuildWaveform(ctx context.Context, blobs BlobStore, version string, playback webArtifact, duration int64, oldKey string) error {
	dir, err := os.MkdirTemp("", "samtdi-waveform-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)

	path := filepath.Join(dir, "playback.wav")
	if err := copyVerifiedPlayback(ctx, blobs, playback, path); err != nil {
		return err
	}
	channels, err := w.verifyInput(ctx, "wav", path)
	if err != nil {
		return err
	}
	encoded, err := w.webWaveform(ctx, path, channels, duration)
	if err != nil {
		return err
	}

	digest := sha256.Sum256(encoded)
	hash := hex.EncodeToString(digest[:])
	key := oldKey + "/channels/" + hash
	if _, err := w.pool.Exec(ctx, `INSERT INTO web_media_garbage(object_key,available_at)
 VALUES($1,now()+interval '10 minutes') ON CONFLICT(object_key) DO NOTHING`, key); err != nil {
		return err
	}
	if err := blobs.Put(ctx, key, BlobMetadata{Size: int64(len(encoded)), SHA256: hash}, bytes.NewReader(encoded)); err != nil {
		return err
	}

	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE web_media_versions SET peaks_key=$2,peaks_bytes=$3,peaks_hash=$4,peaks_revision=2
 WHERE id=$1`, version, key, len(encoded), hash); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM web_media_garbage WHERE object_key=$1", key); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO web_media_garbage(object_key,available_at) VALUES($1,now())
 ON CONFLICT(object_key) DO NOTHING`, oldKey); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func copyVerifiedPlayback(ctx context.Context, blobs BlobStore, expected webArtifact, path string) error {
	body, meta, err := blobs.Open(ctx, expected.key)
	if err != nil {
		return err
	}
	defer body.Close()
	if expected.size < 1 || meta.Size != expected.size || meta.SHA256 != expected.digest {
		return errors.New("playback metadata does not match")
	}

	output, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	digest := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(output, digest), io.LimitReader(body, expected.size+1))
	if err := errors.Join(copyErr, output.Close()); err != nil {
		return err
	}
	if size != expected.size || hex.EncodeToString(digest.Sum(nil)) != expected.digest {
		return errors.New("playback checksum does not match")
	}
	return nil
}
