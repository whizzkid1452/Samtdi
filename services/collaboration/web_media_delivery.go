package collaboration

import (
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

func (s *Server) webMediaDeliveryRoutes() {
	base := "/v1/projects/{project}/versions/{version}"
	s.mux.HandleFunc("GET "+base+"/files/{asset}", s.withSession(s.serveWebAsset))
	s.mux.HandleFunc("POST "+base+"/retry", s.withSession(s.retryWebVersion))
}

func (s *Server) serveWebAsset(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.webRead(w, r, session) {
		return
	}
	version := r.PathValue("version")
	if !uuidPattern.MatchString(version) {
		problem(w, 404, "resource_not_found")
		return
	}
	if s.blobs == nil {
		problem(w, 503, "storage_unavailable")
		return
	}
	var asset webArtifact
	var filename string
	var contentType, disposition string
	var columns string
	switch r.PathValue("asset") {
	case "original":
		columns = "original_key,original_bytes,original_hash"
		disposition = "attachment"
	case "playback":
		columns = "playback_key,playback_bytes,playback_hash"
		contentType = "audio/wav"
		disposition = "inline"
	case "peaks":
		columns = "peaks_key,peaks_bytes,peaks_hash"
		contentType = "application/json"
	default:
		problem(w, 404, "resource_not_found")
		return
	}
	err := s.pool.QueryRow(r.Context(), "SELECT filename,"+columns+
		" FROM web_media_versions WHERE project_id=$1 AND id=$2 AND state='ready'", r.PathValue("project"), version).
		Scan(&filename, &asset.key, &asset.size, &asset.digest)
	if err != nil {
		writeWebError(w, "read_web_asset", err)
		return
	}
	if contentType == "" {
		contentType = "audio/wav"
		if strings.EqualFold(filepath.Ext(filename), ".mp3") {
			contentType = "audio/mpeg"
		}
	}
	if r.PathValue("asset") == "playback" {
		filename = "playback.wav"
	}

	status, length := http.StatusOK, asset.size
	var body io.ReadCloser
	var meta BlobMetadata
	var contentRange string
	if raw := r.Header.Get("Range"); raw != "" && r.PathValue("asset") != "peaks" {
		start, end, ok := parseAudioRange(raw, asset.size)
		if !ok {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", asset.size))
			problem(w, http.StatusRequestedRangeNotSatisfiable, "invalid_range")
			return
		}
		status, length = http.StatusPartialContent, end-start+1
		contentRange = fmt.Sprintf("bytes %d-%d/%d", start, end, asset.size)
		if r.Method == http.MethodHead {
			meta, err = s.blobs.Head(r.Context(), asset.key)
		} else {
			body, meta, err = s.blobs.OpenRange(r.Context(), asset.key, start, end)
		}
	} else if r.Method == http.MethodHead {
		meta, err = s.blobs.Head(r.Context(), asset.key)
	} else {
		body, meta, err = s.blobs.Open(r.Context(), asset.key)
	}
	if body != nil {
		defer body.Close()
	}
	if err != nil || meta.Size != asset.size || meta.SHA256 != asset.digest {
		problem(w, http.StatusBadGateway, "media_unavailable")
		return
	}
	if contentRange != "" {
		w.Header().Set("Content-Range", contentRange)
	}
	if r.PathValue("asset") != "peaks" {
		w.Header().Set("Accept-Ranges", "bytes")
	}
	if disposition != "" {
		w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": filename}))
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.WriteHeader(status)
	if body != nil {
		_, _ = io.CopyN(w, body, length)
	}
}

func (s *Server) retryWebVersion(w http.ResponseWriter, r *http.Request, session Session) {
	version, project := r.PathValue("version"), r.PathValue("project")
	if !uuidPattern.MatchString(version) {
		problem(w, 404, "resource_not_found")
		return
	}
	s.webWrite(w, r, session, Editor, false, http.StatusAccepted, func(ctx context.Context, tx pgx.Tx, _ Role) (any, error) {
		result, err := tx.Exec(ctx, `UPDATE web_media_jobs j SET finished_at=NULL,attempts=0,available_at=now()
 FROM web_media_versions v JOIN web_uploads u ON u.id=v.id JOIN web_media_items m ON m.id=v.item_id
 WHERE j.version_id=v.id AND v.id=$1 AND v.project_id=$2 AND v.state='failed'
 AND v.failure='processing_failed' AND m.archived_at IS NULL AND u.expires_at>now() AND u.cleaned_at IS NULL`, version, project)
		if err != nil {
			return nil, err
		}
		if result.RowsAffected() != 1 {
			return nil, webProblem{409, "media_retry_unavailable"}
		}
		value, err := scanWebVersion(tx.QueryRow(ctx, `UPDATE web_media_versions SET state='queued',failure=NULL WHERE id=$1 RETURNING `+webVersionColumns, version))
		if err != nil {
			return nil, err
		}
		return value, appendWebActivity(ctx, tx, project, session.AccountID, "version.retried", version, nil)
	})
}
