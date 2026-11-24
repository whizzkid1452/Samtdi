package collaboration

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	webJobTimeout      = 8 * time.Minute
	webMediaMaxSeconds = 1800
	webJobAttempts     = 3
)

type webMediaJob struct {
	version        string
	project        string
	kind           string
	size           int64
	lease          string
	attempt        int
	expectedSHA256 string
}

type webArtifact struct {
	key    string
	size   int64
	digest string
}

type webMediaWorker struct {
	pool    *pgxpool.Pool
	store   *s3Store
	ffmpeg  string
	ffprobe string
}

var errInvalidMedia = errors.New("unsupported or invalid audio")
var errStaleMediaLease = errors.New("media job lease lost")

func RunWebMediaWorker(ctx context.Context, pool *pgxpool.Pool, settings S3Config, allowLoopback bool) error {
	release, err := AcquireMaintenance(ctx, pool, false)
	if err != nil {
		return err
	}
	defer release()
	if err := Migrate(ctx, pool); err != nil {
		return err
	}

	blobs, err := newS3Store(ctx, settings, allowLoopback)
	if err != nil {
		return err
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return errors.New("FFmpeg executable is required")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		return errors.New("FFprobe executable is required")
	}
	worker := webMediaWorker{pool: pool, store: blobs.(*s3Store), ffmpeg: ffmpeg, ffprobe: ffprobe}
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	lastCleanup := time.Time{}
	for ctx.Err() == nil {
		if time.Since(lastCleanup) >= time.Minute {
			cleanup, cancel := context.WithTimeout(ctx, 10*time.Second)
			if err := worker.cleanup(cleanup); err != nil && ctx.Err() == nil {
				slog.Warn("media cleanup failed", "error_type", errorType(err))
			}
			cancel()
			lastCleanup = time.Now()
		}
		job, err := worker.claim(ctx)
		if err == nil {
			worker.runJob(ctx, job)
			continue
		}
		if !errors.Is(err, pgx.ErrNoRows) && ctx.Err() == nil {
			slog.Error("media job claim failed", "error_type", errorType(err))
		}
		select {
		case <-ctx.Done():
		case <-tick.C:
		}
	}
	return nil
}

func (w webMediaWorker) claim(ctx context.Context) (webMediaJob, error) {
	var job webMediaJob
	err := w.pool.QueryRow(ctx, `WITH candidate AS (
 SELECT j.version_id FROM web_media_jobs j
 WHERE j.finished_at IS NULL AND j.available_at<=now() AND (j.leased_until IS NULL OR j.leased_until<=now())
 ORDER BY j.available_at,j.version_id LIMIT 1 FOR UPDATE SKIP LOCKED
 ), leased AS (
 UPDATE web_media_jobs j SET lease_id=gen_random_uuid(),leased_until=now()+interval '10 minutes',attempts=attempts+1
 FROM candidate c WHERE j.version_id=c.version_id RETURNING j.version_id,j.lease_id,j.attempts
 ), started AS (
 UPDATE web_media_versions v SET state='processing',failure=NULL FROM leased l WHERE v.id=l.version_id RETURNING v.id,v.project_id
 )
 SELECT v.id::text,v.project_id::text,u.kind,u.bytes,l.lease_id::text,l.attempts,COALESCE(u.render_source->>'audio_sha256','')
 FROM started v JOIN leased l ON l.version_id=v.id JOIN web_uploads u ON u.id=v.id`).Scan(&job.version, &job.project, &job.kind, &job.size, &job.lease, &job.attempt, &job.expectedSHA256)
	return job, err
}

func (w webMediaWorker) runJob(ctx context.Context, job webMediaJob) {
	run, cancel := context.WithTimeout(ctx, webJobTimeout)
	defer cancel()

	var duration int64
	var assets [3]webArtifact
	var err error
	if job.attempt > webJobAttempts {
		err = errors.New("media processing attempts exhausted")
	} else {
		duration, assets, err = w.prepare(run, job)
	}
	save, done := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer done()
	if err == nil {
		err = w.finish(save, job, duration, assets)
	}
	if err != nil && !errors.Is(err, errStaleMediaLease) {
		if failure := w.fail(save, job, err); failure != nil {
			slog.Error("media job result failed", "error_type", errorType(failure))
		}
	}
}

func (w webMediaWorker) prepare(ctx context.Context, job webMediaJob) (int64, [3]webArtifact, error) {
	var assets [3]webArtifact
	directory, err := os.MkdirTemp("", "samtdi-media-")
	if err != nil {
		return 0, assets, err
	}
	defer os.RemoveAll(directory)
	original := filepath.Join(directory, "source."+job.kind)
	playback := filepath.Join(directory, "playback.wav")
	peaksPath := filepath.Join(directory, "peaks.json")

	body, meta, err := w.store.Open(ctx, webTemporaryKey(job.project, job.version))
	if err != nil {
		return 0, assets, err
	}
	defer body.Close()
	if meta.Size != job.size || job.size < 1 || job.size > webUploadLimit {
		return 0, assets, errInvalidMedia
	}
	file, err := os.OpenFile(original, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return 0, assets, err
	}
	digest := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, digest), io.LimitReader(body, job.size+1))
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		return 0, assets, errors.Join(copyErr, closeErr)
	}
	if written != job.size || job.expectedSHA256 != "" && hex.EncodeToString(digest.Sum(nil)) != job.expectedSHA256 {
		return 0, assets, errInvalidMedia
	}

	channelCount, err := w.verifyInput(ctx, job.kind, original)
	if err != nil {
		return 0, assets, err
	}
	cmd := exec.CommandContext(ctx, w.ffmpeg, "-nostdin", "-v", "error", "-xerror", "-threads", "1",
		"-protocol_whitelist", "file,pipe", "-f", job.kind, "-i", original,
		"-map", "0:a:0", "-vn", "-sn", "-dn", "-t", "1801", "-ar", "44100", "-c:a", "pcm_s16le", "-f", "wav", playback)
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return 0, assets, ctx.Err()
		}
		return 0, assets, errInvalidMedia
	}
	duration, err := w.playbackDuration(ctx, playback)
	if err != nil {
		return 0, assets, err
	}
	pcm, err := exec.CommandContext(ctx, w.ffmpeg, "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
		"-f", "wav", "-i", playback, "-t", "1800", "-ac", strconv.Itoa(channelCount), "-ar", "4000", "-f", "s16le", "pipe:1").Output()
	if err != nil {
		return 0, assets, err
	}
	peaks, channelPeaks, err := encodeWebPeaks(pcm, channelCount)
	if err != nil {
		return 0, assets, err
	}
	encoded, err := json.Marshal(webWaveform{DurationMS: duration, Peaks: peaks, ChannelPeaks: channelPeaks})
	if err != nil {
		return 0, assets, err
	}
	if err := os.WriteFile(peaksPath, encoded, 0600); err != nil {
		return 0, assets, err
	}

	prefix := "web/versions/" + job.project + "/" + job.version + "/" + job.lease + "/"
	for i, path := range []string{original, playback, peaksPath} {
		asset, err := w.storeArtifact(ctx, job, prefix+filepath.Base(path), path)
		if err != nil {
			return 0, assets, err
		}
		assets[i] = asset
	}
	return duration, assets, nil
}

func (w webMediaWorker) verifyInput(ctx context.Context, kind, path string) (int, error) {
	raw, err := exec.CommandContext(ctx, w.ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe",
		"-f", kind, "-select_streams", "a", "-show_entries", "stream=codec_name,channels", "-of", "json", path).Output()
	if err != nil {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		return 0, errInvalidMedia
	}
	var metadata struct {
		Streams []struct {
			Codec    string `json:"codec_name"`
			Channels int    `json:"channels"`
		} `json:"streams"`
	}
	if json.Unmarshal(raw, &metadata) != nil || len(metadata.Streams) != 1 {
		return 0, errInvalidMedia
	}
	stream := metadata.Streams[0]
	if stream.Channels < 1 || stream.Channels > 2 {
		return 0, errInvalidMedia
	}
	if kind == "mp3" && stream.Codec == "mp3" {
		return stream.Channels, nil
	}
	if kind == "wav" && (stream.Codec == "pcm_s16le" || stream.Codec == "pcm_s24le" || stream.Codec == "pcm_f32le") {
		return stream.Channels, nil
	}
	return 0, errInvalidMedia
}

func (w webMediaWorker) playbackDuration(ctx context.Context, path string) (int64, error) {
	raw, err := exec.CommandContext(ctx, w.ffprobe, "-v", "error", "-f", "wav", "-show_entries", "format=duration", "-of", "csv=p=0", path).Output()
	if err != nil {
		return 0, err
	}
	seconds, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	if err != nil || math.IsNaN(seconds) || seconds <= 0 || seconds > webMediaMaxSeconds {
		return 0, errInvalidMedia
	}
	return max(1, int64(math.Round(seconds*1000))), nil
}

type webWaveform struct {
	DurationMS   int64       `json:"duration_ms"`
	Peaks        []float64   `json:"peaks"`
	ChannelPeaks [][]float64 `json:"channel_peaks"`
}

func encodeWebPeaks(raw []byte, channels int) ([]float64, [][]float64, error) {
	const sampleBytes = 2
	if channels != 1 && channels != 2 {
		return nil, nil, errInvalidMedia
	}

	frameBytes := sampleBytes * channels
	if len(raw) == 0 || len(raw)%frameBytes != 0 {
		return nil, nil, errInvalidMedia
	}

	frames := len(raw) / frameBytes
	bins := min(frames, 1024)
	mixed := make([]float64, bins)
	peaks := make([][]float64, channels)
	for channel := range peaks {
		peaks[channel] = make([]float64, bins)
	}

	for frame := range frames {
		bin := frame * bins / frames
		var sum int
		for channel := range channels {
			offset := frame*frameBytes + channel*sampleBytes
			value := int(int16(binary.LittleEndian.Uint16(raw[offset : offset+sampleBytes])))
			sum += value
			peaks[channel][bin] = max(peaks[channel][bin], math.Abs(float64(value))/32768)
		}
		mixed[bin] = max(mixed[bin], math.Abs(float64(sum))/float64(channels*32768))
	}
	return mixed, peaks, nil
}

func (w webMediaWorker) storeArtifact(ctx context.Context, job webMediaJob, key, path string) (webArtifact, error) {
	f, err := os.Open(path)
	if err != nil {
		return webArtifact{}, err
	}
	defer f.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, f)
	if err != nil {
		return webArtifact{}, err
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return webArtifact{}, err
	}
	asset := webArtifact{key: key, size: size, digest: hex.EncodeToString(hash.Sum(nil))}
	reservation, err := w.pool.Exec(ctx, `INSERT INTO web_media_garbage(object_key,available_at)
 SELECT $1,leased_until + interval '5 minutes' FROM web_media_jobs WHERE version_id=$2 AND lease_id=$3`, key, job.version, job.lease)
	if err != nil {
		return webArtifact{}, err
	}
	if reservation.RowsAffected() != 1 {
		return webArtifact{}, errStaleMediaLease
	}
	err = w.store.Put(ctx, key, BlobMetadata{Size: size, SHA256: asset.digest}, f)
	return asset, err
}

func (w webMediaWorker) finish(ctx context.Context, job webMediaJob, duration int64, assets [3]webArtifact) error {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockProject(ctx, tx, job.project); err != nil {
		return err
	}
	var active bool
	err = tx.QueryRow(ctx, `SELECT p.archived_at IS NULL AND m.archived_at IS NULL FROM web_media_versions v
 JOIN projects p ON p.id=v.project_id JOIN web_media_items m ON m.id=v.item_id WHERE v.id=$1`, job.version).Scan(&active)
	if err != nil {
		return err
	}
	if !active {
		return errInvalidMedia
	}
	result, err := tx.Exec(ctx, `UPDATE web_media_jobs SET finished_at=now(),lease_id=NULL,leased_until=NULL
 WHERE version_id=$1 AND lease_id=$2 AND leased_until>now()`, job.version, job.lease)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errStaleMediaLease
	}
	_, err = tx.Exec(ctx, `UPDATE web_media_versions SET state='ready',duration_ms=$2,failure=NULL,
 original_key=$3,original_bytes=$4,original_hash=$5,playback_key=$6,playback_bytes=$7,playback_hash=$8,
 peaks_key=$9,peaks_bytes=$10,peaks_hash=$11 WHERE id=$1`, job.version, duration,
		assets[0].key, assets[0].size, assets[0].digest, assets[1].key, assets[1].size, assets[1].digest, assets[2].key, assets[2].size, assets[2].digest)
	if err != nil {
		return err
	}
	for _, asset := range assets {
		if _, err = tx.Exec(ctx, "DELETE FROM web_media_garbage WHERE object_key=$1", asset.key); err != nil {
			return err
		}
	}
	if err = appendWebActivity(ctx, tx, job.project, "", "version.ready", job.version, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (w webMediaWorker) fail(ctx context.Context, job webMediaJob, cause error) error {
	permanent := errors.Is(cause, errInvalidMedia)
	final := permanent || job.attempt >= webJobAttempts
	state, reason := "queued", "processing_retry"
	if final {
		state, reason = "failed", "processing_failed"
	}
	if permanent {
		reason = "invalid_audio"
	}

	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `UPDATE web_media_jobs SET lease_id=NULL,leased_until=NULL,
 available_at=now()+make_interval(secs => $3),finished_at=CASE WHEN $4 THEN now() ELSE NULL END
 WHERE version_id=$1 AND lease_id=$2 AND leased_until>now()`, job.version, job.lease, job.attempt*5, final)
	if err != nil || result.RowsAffected() == 0 {
		return err
	}
	if _, err = tx.Exec(ctx, "UPDATE web_media_versions SET state=$2,failure=$3 WHERE id=$1", job.version, state, reason); err != nil {
		return err
	}
	if final {
		if err = appendWebActivity(ctx, tx, job.project, "", "version.failed", job.version, map[string]any{"reason": reason}); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (w webMediaWorker) cleanup(ctx context.Context) error {
	rows, err := w.pool.Query(ctx, `SELECT object_key FROM web_media_garbage WHERE available_at<=now() ORDER BY available_at LIMIT 32`)
	if err != nil {
		return err
	}
	keys, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, key := range keys {
		if _, err = w.store.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &w.store.bucket, Key: &key}); err != nil {
			return err
		}
		if _, err = w.pool.Exec(ctx, "DELETE FROM web_media_garbage WHERE object_key=$1", key); err != nil {
			return err
		}
	}
	rows, err = w.pool.Query(ctx, `SELECT u.project_id::text,u.id::text FROM web_uploads u LEFT JOIN web_media_jobs j ON j.version_id=u.id
 WHERE u.cleaned_at IS NULL AND u.expires_at+interval '1 day'<now() AND (j.version_id IS NULL OR j.finished_at IS NOT NULL)
 ORDER BY u.expires_at LIMIT 32`)
	if err != nil {
		return err
	}
	type expired struct{ Project, ID string }
	uploads, err := pgx.CollectRows(rows, pgx.RowToStructByPos[expired])
	if err != nil {
		return err
	}
	for _, upload := range uploads {
		if err := w.cleanExpiredUpload(ctx, upload.Project, upload.ID); err != nil {
			return err
		}
	}
	return nil
}

func (w webMediaWorker) cleanExpiredUpload(ctx context.Context, project, upload string) error {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Hold the upload row until deletion so a retried publish cannot renew an object being deleted.
	result, err := tx.Exec(ctx, `UPDATE web_uploads u SET cleaned_at=now() WHERE u.id=$1 AND u.cleaned_at IS NULL
 AND u.expires_at+interval '1 day'<now()
 AND NOT EXISTS (SELECT 1 FROM web_media_jobs j WHERE j.version_id=u.id AND j.finished_at IS NULL)`, upload)
	if err != nil || result.RowsAffected() == 0 {
		return err
	}

	key := webTemporaryKey(project, upload)
	if _, err := w.store.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &w.store.bucket, Key: &key}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
