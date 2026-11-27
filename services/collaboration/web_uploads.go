package collaboration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
)

const (
	webUploadLimit  = 500_000_000
	webUploadWindow = 15 * time.Minute
)

type webMediaItem struct {
	ID            string      `json:"id"`
	Title         string      `json:"title"`
	ArchivedAt    *time.Time  `json:"archived_at,omitempty"`
	Latest        *webVersion `json:"latest,omitempty"`
	LatestReadyID string      `json:"latest_ready_id,omitempty"`
}

type webRenderSource struct {
	SnapshotID  string          `json:"snapshot_id"`
	AudioSHA256 string          `json:"audio_sha256"`
	CommitOID   string          `json:"commit_oid,omitempty"`
	ReviewID    string          `json:"review_id,omitempty"`
	Settings    json.RawMessage `json:"settings,omitempty"`
}

var renderDigest = regexp.MustCompile(`^[0-9a-f]{64}$`)
var renderCommit = regexp.MustCompile(`^[0-9a-f]{40}$`)

type webVersion struct {
	ID          string           `json:"id"`
	ItemID      string           `json:"item_id"`
	Filename    string           `json:"filename"`
	Description string           `json:"description"`
	State       string           `json:"state"`
	DurationMS  *int64           `json:"duration_ms,omitempty"`
	Failure     *string          `json:"failure,omitempty"`
	CreatedAt   time.Time        `json:"created_at"`
	Source      *webRenderSource `json:"source,omitempty"`
}

const webVersionColumns = "id::text, item_id::text, filename, description, state, duration_ms, failure, created_at, (SELECT u.render_source FROM web_uploads u WHERE u.id=web_media_versions.id) AS render_source"

func scanWebVersion(row pgx.Row) (webVersion, error) {
	var v webVersion
	err := row.Scan(&v.ID, &v.ItemID, &v.Filename, &v.Description, &v.State, &v.DurationMS, &v.Failure, &v.CreatedAt, &v.Source)
	return v, err
}

func (s *Server) webUploadRoutes() {
	base := "/v1/projects/{project}"
	s.mux.HandleFunc("GET "+base+"/media", s.withSession(s.listWebMedia))
	s.mux.HandleFunc("POST "+base+"/media", s.withSession(s.createWebMedia))
	s.mux.HandleFunc("GET "+base+"/media/{item}", s.withSession(s.getWebMedia))
	s.mux.HandleFunc("PATCH "+base+"/media/{item}", s.withSession(s.archiveWebMedia))
	s.mux.HandleFunc("GET "+base+"/media/{item}/versions", s.withSession(s.listWebVersions))
	s.mux.HandleFunc("GET "+base+"/versions/{version}", s.withSession(s.getWebVersion))
	s.mux.HandleFunc("POST "+base+"/media/{item}/uploads", s.withSession(s.startWebUpload))
	s.mux.HandleFunc("POST "+base+"/uploads/{upload}/complete", s.withSession(s.completeWebUpload))
}

const webMediaSummary = `SELECT m.id::text,m.title,m.archived_at,to_jsonb(latest),COALESCE(ready.id::text,'')
 FROM web_media_items m
 LEFT JOIN LATERAL (SELECT v.id,v.item_id,v.filename,v.description,v.state,v.duration_ms,v.failure,v.created_at
 FROM web_media_versions v WHERE v.project_id=m.project_id AND v.item_id=m.id
 ORDER BY v.created_at DESC,v.id DESC LIMIT 1) latest ON true
 LEFT JOIN LATERAL (SELECT v.id FROM web_media_versions v
 WHERE v.project_id=m.project_id AND v.item_id=m.id AND v.state='ready'
 ORDER BY v.created_at DESC,v.id DESC LIMIT 1) ready ON true`

func scanWebMedia(row pgx.Row) (webMediaItem, error) {
	var item webMediaItem
	err := row.Scan(&item.ID, &item.Title, &item.ArchivedAt, &item.Latest, &item.LatestReadyID)
	return item, err
}

func (s *Server) getWebMedia(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.webRead(w, r, session) {
		return
	}
	item := r.PathValue("item")
	if !uuidPattern.MatchString(item) {
		problem(w, 404, "resource_not_found")
		return
	}
	value, err := scanWebMedia(s.pool.QueryRow(r.Context(), webMediaSummary+" WHERE m.project_id=$1 AND m.id=$2",
		r.PathValue("project"), item))
	if err != nil {
		writeWebError(w, "read_web_media_item", err)
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (s *Server) listWebMedia(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.webRead(w, r, session) {
		return
	}
	query := r.URL.Query()
	before, search, archived := query.Get("before"), strings.TrimSpace(query.Get("q")), query.Get("archived")
	if (before != "" && !uuidPattern.MatchString(before)) ||
		(search != "" && !webText(search, 200)) ||
		(archived != "" && archived != "true" && archived != "false") {
		problem(w, http.StatusBadRequest, "invalid_media_query")
		return
	}

	rows, err := s.pool.Query(r.Context(), webMediaSummary+`
 WHERE m.project_id=$1 AND ($2='' OR (m.created_at,m.id)<(SELECT created_at,id FROM web_media_items
 WHERE project_id=$1 AND id=NULLIF($2,'')::uuid))
 AND ($3='' OR strpos(lower(m.title),lower($3))>0)
 AND ($4='' OR (m.archived_at IS NOT NULL)=NULLIF($4,'')::boolean)
 ORDER BY m.created_at DESC,m.id DESC LIMIT 100`, r.PathValue("project"), before, search, archived)
	if err != nil {
		internal(w, "list_web_media", err)
		return
	}
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (webMediaItem, error) { return scanWebMedia(row) })
	if err != nil {
		internal(w, "read_web_media", err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) createWebMedia(w http.ResponseWriter, r *http.Request, session Session) {
	var input struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if !webText(input.Title, 160) || (input.ID != "" && !uuidPattern.MatchString(input.ID)) {
		problem(w, http.StatusBadRequest, "invalid_media_title")
		return
	}

	projectID := r.PathValue("project")
	s.webWrite(w, r, session, Editor, false, http.StatusCreated, func(ctx context.Context, tx pgx.Tx, _ Role) (any, error) {
		item := webMediaItem{Title: strings.TrimSpace(input.Title)}
		err := tx.QueryRow(ctx, `INSERT INTO web_media_items(id,project_id,title)
 VALUES (COALESCE(NULLIF($1,'')::uuid,gen_random_uuid()),$2,$3)
 ON CONFLICT (id) DO NOTHING RETURNING id::text`, input.ID, projectID, item.Title).Scan(&item.ID)
		if errors.Is(err, pgx.ErrNoRows) {
			existing, findErr := scanWebMedia(tx.QueryRow(ctx, webMediaSummary+" WHERE m.project_id=$1 AND m.id=$2 AND m.title=$3",
				projectID, input.ID, item.Title))
			if errors.Is(findErr, pgx.ErrNoRows) {
				return nil, webProblem{409, "idempotency_conflict"}
			}
			return existing, findErr
		}
		if err != nil {
			return nil, err
		}
		return item, appendWebActivity(ctx, tx, projectID, session.AccountID, "media.created", item.ID, nil)
	})
}

func (s *Server) archiveWebMedia(w http.ResponseWriter, r *http.Request, session Session) {
	var input struct {
		Archived *bool `json:"archived"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	item := r.PathValue("item")
	project := r.PathValue("project")
	if input.Archived == nil || !uuidPattern.MatchString(item) {
		problem(w, http.StatusBadRequest, "invalid_media_archive")
		return
	}
	s.webWrite(w, r, session, Editor, false, http.StatusNoContent, func(ctx context.Context, tx pgx.Tx, _ Role) (any, error) {
		var id string
		err := tx.QueryRow(ctx, `UPDATE web_media_items SET archived_at=CASE WHEN $3 THEN COALESCE(archived_at,now()) ELSE NULL END
 WHERE project_id=$1 AND id=$2 RETURNING id::text`, project, item, *input.Archived).Scan(&id)
		if err != nil {
			return nil, err
		}
		return nil, appendWebActivity(ctx, tx, project, session.AccountID, "media.archive_changed", id, map[string]any{"archived": *input.Archived})
	})
}

func (s *Server) listWebVersions(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.webRead(w, r, session) {
		return
	}
	item, before := r.PathValue("item"), r.URL.Query().Get("before")
	if !uuidPattern.MatchString(item) || (before != "" && !uuidPattern.MatchString(before)) {
		problem(w, http.StatusBadRequest, "invalid_media_query")
		return
	}
	rows, err := s.pool.Query(r.Context(), `SELECT `+webVersionColumns+` FROM web_media_versions
 WHERE project_id=$1 AND item_id=$2 AND ($3='' OR (created_at,id)<(SELECT created_at,id FROM web_media_versions
 WHERE project_id=$1 AND item_id=$2 AND id=NULLIF($3,'')::uuid)) ORDER BY created_at DESC,id DESC LIMIT 100`, r.PathValue("project"), item, before)
	if err != nil {
		internal(w, "list_web_versions", err)
		return
	}
	versions, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (webVersion, error) { return scanWebVersion(row) })
	if err != nil {
		internal(w, "read_web_versions", err)
		return
	}
	writeJSON(w, http.StatusOK, versions)
}

func (s *Server) getWebVersion(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.webRead(w, r, session) {
		return
	}
	version := r.PathValue("version")
	if !uuidPattern.MatchString(version) {
		problem(w, 404, "resource_not_found")
		return
	}
	value, err := scanWebVersion(s.pool.QueryRow(r.Context(), `SELECT `+webVersionColumns+` FROM web_media_versions WHERE project_id=$1 AND id=$2`, r.PathValue("project"), version))
	if err != nil {
		writeWebError(w, "read_web_version", err)
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func webTemporaryKey(project, upload string) string { return "web/incoming/" + project + "/" + upload }

func (s *Server) startWebUpload(w http.ResponseWriter, r *http.Request, session Session) {
	store, ok := s.blobs.(*s3Store)
	if !ok {
		problem(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	var input struct {
		Filename    string           `json:"filename"`
		Bytes       int64            `json:"bytes"`
		Description string           `json:"description"`
		RequestID   string           `json:"request_id"`
		Source      *webRenderSource `json:"source"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	item, project := r.PathValue("item"), r.PathValue("project")
	kind := strings.TrimPrefix(strings.ToLower(filepath.Ext(input.Filename)), ".")
	if !uuidPattern.MatchString(item) || !webText(input.Filename, 200) ||
		strings.ContainsAny(input.Filename, "/\\\r\n") || utf8.RuneCountInString(input.Description) > 2000 ||
		strings.ContainsRune(input.Description, 0) || input.Bytes <= 0 || input.Bytes > store.objectLimit() ||
		(kind != "wav" && kind != "mp3") {
		problem(w, http.StatusBadRequest, "invalid_upload")
		return
	}
	source := input.Source
	if input.RequestID != "" && !uuidPattern.MatchString(input.RequestID) ||
		source != nil && (kind != "wav" || input.RequestID == "" ||
			!renderDigest.MatchString(source.SnapshotID) || !renderDigest.MatchString(source.AudioSHA256) ||
			source.CommitOID != "" && !renderCommit.MatchString(source.CommitOID) ||
			source.ReviewID != "" && !uuidPattern.MatchString(source.ReviewID) ||
			len(source.Settings) > 16*1024) {
		problem(w, http.StatusBadRequest, "invalid_render_source")
		return
	}

	s.webWrite(w, r, session, Editor, false, http.StatusCreated, func(ctx context.Context, tx pgx.Tx, _ Role) (any, error) {
		if source != nil && source.ReviewID != "" {
			review, err := readReview(ctx, tx, project, source.ReviewID)
			if err != nil {
				return nil, err
			}
			if source.CommitOID == "" || source.CommitOID != review.BaseOID && source.CommitOID != review.HeadOID {
				return nil, webProblem{400, "invalid_render_source"}
			}
		}

		var id string
		var expires time.Time
		var completed bool
		var sourceValue any
		if source != nil {
			sourceValue = source
		}
		err := tx.QueryRow(ctx, `INSERT INTO web_uploads(id,project_id,item_id,actor_id,filename,description,bytes,kind,render_source)
 SELECT COALESCE(NULLIF($8,'')::uuid,gen_random_uuid()),$1,id,$3,$4,$5,$6,$7,$9::jsonb FROM web_media_items
 WHERE project_id=$1 AND id=$2 AND archived_at IS NULL ON CONFLICT(id) DO NOTHING RETURNING id::text,expires_at`,
			project, item, session.AccountID, input.Filename, input.Description, input.Bytes, kind, input.RequestID, sourceValue).Scan(&id, &expires)
		if errors.Is(err, pgx.ErrNoRows) && input.RequestID != "" {
			err = tx.QueryRow(ctx, `SELECT u.id::text,u.expires_at,u.completion_key IS NOT NULL
 FROM web_uploads u JOIN web_media_items m ON m.id=u.item_id
 WHERE u.id=$8 AND u.project_id=$1 AND u.item_id=$2 AND u.actor_id=$3 AND m.archived_at IS NULL
 AND u.filename=$4 AND u.description=$5 AND u.bytes=$6 AND u.kind=$7 AND u.render_source IS NOT DISTINCT FROM $9::jsonb`,
				project, item, session.AccountID, input.Filename, input.Description, input.Bytes, kind, input.RequestID, sourceValue).
				Scan(&id, &expires, &completed)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, webProblem{409, "idempotency_conflict"}
			}
		}
		if err != nil {
			return nil, err
		}
		if completed {
			return map[string]any{"id": id, "url": "", "headers": map[string][]string{}, "expires_at": expires, "version_id": id}, nil
		}
		remaining := time.Until(expires).Truncate(time.Second)
		if remaining <= 0 && input.RequestID != "" {
			err := tx.QueryRow(ctx, `UPDATE web_uploads SET expires_at=clock_timestamp()+make_interval(secs => $2),cleaned_at=NULL
 WHERE id=$1 AND completion_key IS NULL RETURNING expires_at`, id, webUploadWindow.Seconds()).Scan(&expires)
			if err != nil {
				return nil, err
			}
			remaining = time.Until(expires).Truncate(time.Second)
		}
		if remaining <= 0 {
			return nil, webProblem{410, "upload_session_expired"}
		}

		signing, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		request, err := s3.NewPresignClient(store.client).PresignPutObject(signing, &s3.PutObjectInput{
			Bucket: &store.bucket, Key: aws.String(webTemporaryKey(project, id)), ContentLength: &input.Bytes,
		}, s3.WithPresignExpires(min(webUploadWindow, remaining)))
		if err != nil {
			return nil, err
		}
		headers := request.SignedHeader.Clone()
		headers.Del("Host")
		headers.Del("Content-Length")
		return map[string]any{"id": id, "url": request.URL, "headers": headers, "expires_at": expires}, nil
	})
}

func (s *Server) completeWebUpload(w http.ResponseWriter, r *http.Request, session Session) {
	upload, project := r.PathValue("upload"), r.PathValue("project")
	key := r.Header.Get("Idempotency-Key")
	if !uuidPattern.MatchString(upload) || !webText(key, 128) {
		problem(w, http.StatusBadRequest, "invalid_upload_completion")
		return
	}
	if s.blobs == nil {
		problem(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	s.webWrite(w, r, session, Editor, false, http.StatusAccepted, func(ctx context.Context, tx pgx.Tx, _ Role) (any, error) {
		var previous string
		err := tx.QueryRow(ctx, `SELECT id::text FROM web_uploads WHERE project_id=$1 AND actor_id=$2 AND completion_key=$3`, project, session.AccountID, key).Scan(&previous)
		if err == nil {
			if previous != upload {
				return nil, webProblem{409, "idempotency_conflict"}
			}
			return scanWebVersion(tx.QueryRow(ctx, `SELECT `+webVersionColumns+` FROM web_media_versions WHERE id=$1`, upload))
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		var bytes int64
		err = tx.QueryRow(ctx, `SELECT u.bytes FROM web_uploads u JOIN web_media_items m ON m.id=u.item_id
 WHERE u.id=$1 AND u.project_id=$2 AND u.actor_id=$3 AND u.completion_key IS NULL
 AND u.expires_at>now() AND m.archived_at IS NULL`, upload, project, session.AccountID).Scan(&bytes)
		if err != nil {
			return nil, err
		}
		probe, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		metadata, err := s.blobs.Head(probe, webTemporaryKey(project, upload))
		if errors.Is(err, errBlobMissing) || (err == nil && metadata.Size != bytes) {
			return nil, webProblem{409, "upload_missing_or_size_changed"}
		}
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, "UPDATE web_uploads SET completion_key=$2 WHERE id=$1", upload, key); err != nil {
			return nil, err
		}
		version, err := scanWebVersion(tx.QueryRow(ctx, `INSERT INTO web_media_versions(id,project_id,item_id,filename,description)
 SELECT id,project_id,item_id,filename,description FROM web_uploads WHERE id=$1 RETURNING `+webVersionColumns, upload))
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, "INSERT INTO web_media_jobs(version_id) VALUES ($1)", upload); err != nil {
			return nil, err
		}
		return version, appendWebActivity(ctx, tx, project, session.AccountID, "version.queued", upload, nil)
	})
}
