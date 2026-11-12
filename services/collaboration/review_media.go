package collaboration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type reviewRenderSettings struct {
	BeginSeconds   float64  `json:"beginSeconds"`
	EndSeconds     float64  `json:"endSeconds"`
	SampleRateHz   int      `json:"sampleRateHz"`
	BitDepth       int      `json:"bitDepth"`
	Channels       int      `json:"channels"`
	BlockSize      int      `json:"blockSize"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
	Stems          []string `json:"stems"`
}

type reviewMedia struct {
	ID           string               `json:"id"`
	ReviewID     string               `json:"review_id"`
	CommitOID    string               `json:"commit_oid"`
	RendererHash string               `json:"renderer_hash"`
	Settings     reviewRenderSettings `json:"settings"`
	State        string               `json:"state"`
	Manifest     json.RawMessage      `json:"manifest,omitempty"`
	Reason       string               `json:"reason,omitempty"`
	MixOID       string               `json:"mix_oid,omitempty"`
	MixBytes     int64                `json:"mix_bytes,omitempty"`
	CreatedAt    time.Time            `json:"created_at"`
	FinishedAt   *time.Time           `json:"finished_at"`
}

const mediaColumns = `id::text, review_id::text, commit_oid, renderer_hash, settings,
 state, manifest, coalesce(reason,''), coalesce(mix_oid,''), coalesce(mix_bytes,0), created_at, finished_at`

func scanReviewMedia(row pgx.Row) (reviewMedia, error) {
	var media reviewMedia
	err := row.Scan(&media.ID, &media.ReviewID, &media.CommitOID, &media.RendererHash, &media.Settings,
		&media.State, &media.Manifest, &media.Reason, &media.MixOID, &media.MixBytes, &media.CreatedAt, &media.FinishedAt)
	return media, err
}

func (s *Server) reviewMediaRoutes() {
	base := "/v1/projects/{project}/reviews/{review}/media"
	s.mux.HandleFunc("GET "+base, s.withReviewProject(s.listReviewMedia))
	s.mux.HandleFunc("POST "+base, s.withReviewProject(s.queueReviewMedia))
	s.mux.HandleFunc("GET "+base+"/{media}/wav", s.withReviewProject(s.reviewWAV))
}

func (s *Server) listReviewMedia(w http.ResponseWriter, r *http.Request, _ Session, project reviewProject) {
	target, err := readReview(r.Context(), s.pool, project.id, r.PathValue("review"))
	if err != nil {
		reviewError(w, "media_review", err)
		return
	}

	rows, err := s.pool.Query(r.Context(), `SELECT `+mediaColumns+` FROM review_media_versions WHERE review_id = $1 ORDER BY created_at DESC,id DESC LIMIT 100`, target.ID)
	if err != nil {
		internal(w, "list_review_media", err)
		return
	}
	media, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (reviewMedia, error) { return scanReviewMedia(row) })
	if err != nil {
		internal(w, "read_review_media", err)
		return
	}

	writeJSON(w, http.StatusOK, media)
}

func (s *Server) queueReviewMedia(w http.ResponseWriter, r *http.Request, session Session, project reviewProject) {
	if !project.role.canWrite() {
		problem(w, http.StatusForbidden, "insufficient_role")
		return
	}
	if s.renderer == nil {
		problem(w, http.StatusServiceUnavailable, "renderer_unavailable")
		return
	}

	var input struct {
		CommitOID string  `json:"commit_oid"`
		Begin     float64 `json:"begin_seconds"`
		End       float64 `json:"end_seconds"`
		Retry     bool    `json:"retry"`
	}
	if !readJSON(w, r, &input) {
		return
	}

	ctx := r.Context()
	target, err := readReview(ctx, s.pool, project.id, r.PathValue("review"))
	if err != nil {
		reviewError(w, "queue_media_review", err)
		return
	}
	if (input.CommitOID != target.BaseOID && input.CommitOID != target.HeadOID) ||
		input.Begin < 0 || input.End <= input.Begin || input.End-input.Begin > 600 || input.End > 86400 {
		problem(w, http.StatusBadRequest, "invalid_review_render")
		return
	}

	settings := reviewRenderSettings{BeginSeconds: input.Begin, EndSeconds: input.End, SampleRateHz: 48000,
		BitDepth: 16, Channels: 2, BlockSize: 256, TimeoutSeconds: 480, Stems: []string{}}
	encoded, err := json.Marshal(settings)
	if err != nil {
		internal(w, "encode_render_settings", err)
		return
	}
	digest := sha256.Sum256(encoded)

	media, err := scanReviewMedia(s.pool.QueryRow(ctx, `INSERT INTO review_media_versions
 (review_id,requested_by,commit_oid,renderer_hash,settings_hash,settings)
 SELECT $1,$2,$3,$4,$5,$6 FROM memberships WHERE project_id = $7 AND account_id = $2 AND role IN ('editor','owner')
 ON CONFLICT (review_id,commit_oid,renderer_hash,settings_hash) DO UPDATE SET
 state = CASE WHEN $8 AND review_media_versions.state = 'failed' AND review_media_versions.attempts < 3 THEN 'queued' ELSE review_media_versions.state END
 RETURNING `+mediaColumns, target.ID, session.AccountID, input.CommitOID, s.renderer.hash, hex.EncodeToString(digest[:]), encoded, project.id, input.Retry))
	if err != nil {
		reviewError(w, "queue_review_render", err)
		return
	}

	s.renderer.wake()
	writeJSON(w, http.StatusAccepted, media)
}

func reviewMediaKey(projectID, reviewID, mixOID string) string {
	return "review-media/" + projectID + "/" + reviewID + "/" + mixOID
}

func (s *Server) reviewWAV(w http.ResponseWriter, r *http.Request, _ Session, project reviewProject) {
	reviewID, mediaID := r.PathValue("review"), r.PathValue("media")
	if !uuidPattern.MatchString(reviewID) || !uuidPattern.MatchString(mediaID) {
		problem(w, http.StatusNotFound, "review_media_not_found")
		return
	}

	var digest string
	var size int64
	err := s.pool.QueryRow(r.Context(), `SELECT m.mix_oid,m.mix_bytes FROM review_media_versions m
 JOIN reviews r ON r.id = m.review_id WHERE r.project_id = $1 AND r.id = $2 AND m.id = $3 AND m.state = 'ready'`,
		project.id, reviewID, mediaID).Scan(&digest, &size)
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, http.StatusNotFound, "review_media_not_found")
		return
	}
	if err != nil {
		internal(w, "read_review_wav", err)
		return
	}

	key := reviewMediaKey(project.id, reviewID, digest)
	status := http.StatusOK
	length := size
	var metadata BlobMetadata
	var stream io.ReadCloser
	if r.Method == http.MethodHead {
		metadata, err = s.blobs.Head(r.Context(), key)
	} else if requested := r.Header.Get("Range"); requested != "" {
		start, end, ok := parseAudioRange(requested, size)
		if !ok {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
			problem(w, http.StatusRequestedRangeNotSatisfiable, "invalid_wav_range")
			return
		}

		stream, metadata, err = s.blobs.OpenRange(r.Context(), key, start, end)
		status = http.StatusPartialContent
		length = end - start + 1
		if err == nil {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
		}
	} else {
		stream, metadata, err = s.blobs.Open(r.Context(), key)
	}
	if errors.Is(err, errBlobMissing) {
		problem(w, http.StatusNotFound, "review_wav_unavailable")
		return
	}
	if err != nil {
		internal(w, "open_review_wav", err)
		return
	}
	if stream != nil {
		defer stream.Close()
	}
	if metadata.Size != size || metadata.SHA256 != digest {
		w.Header().Del("Content-Range")
		problem(w, http.StatusConflict, "review_wav_mismatch")
		return
	}

	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.Header().Set("Content-Disposition", `inline; filename="review.wav"`)
	w.WriteHeader(status)
	if stream != nil {
		_, _ = io.CopyN(w, stream, length)
	}
}

func parseAudioRange(input string, size int64) (int64, int64, bool) {
	raw, ok := strings.CutPrefix(input, "bytes=")
	if !ok || strings.Contains(raw, ",") || size <= 0 {
		return 0, 0, false
	}

	first, last, ok := strings.Cut(raw, "-")
	if !ok {
		return 0, 0, false
	}
	if first == "" {
		suffix, err := strconv.ParseInt(last, 10, 64)
		if err != nil || suffix <= 0 {
			return 0, 0, false
		}
		return max(0, size-suffix), size - 1, true
	}

	start, err := strconv.ParseInt(first, 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, false
	}
	if last == "" {
		return start, size - 1, true
	}

	end, err := strconv.ParseInt(last, 10, 64)
	if err != nil || end < start {
		return 0, 0, false
	}

	return start, min(end, size-1), true
}

func readMediaQueue(ctx context.Context, s *Server) (reviewMedia, string, string, error) {
	var media reviewMedia
	var projectID, lease string
	err := s.pool.QueryRow(ctx, `WITH next AS (
  SELECT m.id,r.project_id FROM review_media_versions m JOIN reviews r ON r.id = m.review_id
  WHERE m.renderer_hash = $1 AND (m.state = 'queued' OR (m.state = 'running' AND m.lease_until <= now())) AND m.attempts < 3
  ORDER BY m.created_at,m.id FOR UPDATE OF m SKIP LOCKED LIMIT 1
 )
 UPDATE review_media_versions m SET state = 'running', attempts = m.attempts + 1,
 lease_id = gen_random_uuid(), lease_until = now() + interval '20 minutes', reason = NULL, finished_at = NULL
 FROM next WHERE m.id = next.id
 RETURNING m.id::text,m.review_id::text,m.commit_oid,m.renderer_hash,m.settings,next.project_id::text,m.lease_id::text`,
		s.renderer.hash).Scan(&media.ID, &media.ReviewID, &media.CommitOID, &media.RendererHash, &media.Settings, &projectID, &lease)
	return media, projectID, lease, err
}
