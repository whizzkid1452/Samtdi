package collaboration

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
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
	ID         string     `json:"id"`
	Title      string     `json:"title"`
	ArchivedAt *time.Time `json:"archived_at,omitempty"`
}

type webVersion struct {
	ID          string    `json:"id"`
	ItemID      string    `json:"item_id"`
	Filename    string    `json:"filename"`
	Description string    `json:"description"`
	State       string    `json:"state"`
	DurationMS  *int64    `json:"duration_ms,omitempty"`
	Failure     *string   `json:"failure,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

const webVersionColumns = "id::text, item_id::text, filename, description, state, duration_ms, failure, created_at"

func scanWebVersion(row pgx.Row) (webVersion, error) {
	var v webVersion
	err := row.Scan(&v.ID, &v.ItemID, &v.Filename, &v.Description, &v.State, &v.DurationMS, &v.Failure, &v.CreatedAt)
	return v, err
}

func (s *Server) webUploadRoutes() {
	base := "/v1/projects/{project}"
	s.mux.HandleFunc("GET "+base+"/media", s.withSession(s.listWebMedia))
	s.mux.HandleFunc("POST "+base+"/media", s.withSession(s.createWebMedia))
	s.mux.HandleFunc("PATCH "+base+"/media/{item}", s.withSession(s.archiveWebMedia))
	s.mux.HandleFunc("GET "+base+"/media/{item}/versions", s.withSession(s.listWebVersions))
	s.mux.HandleFunc("GET "+base+"/versions/{version}", s.withSession(s.getWebVersion))
	s.mux.HandleFunc("POST "+base+"/media/{item}/uploads", s.withSession(s.startWebUpload))
	s.mux.HandleFunc("POST "+base+"/uploads/{upload}/complete", s.withSession(s.completeWebUpload))
}

func (s *Server) listWebMedia(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.webRead(w, r, session) {
		return
	}
	before := r.URL.Query().Get("before")
	if before != "" && !uuidPattern.MatchString(before) {
		problem(w, http.StatusBadRequest, "invalid_cursor")
		return
	}
	rows, err := s.pool.Query(r.Context(), `SELECT id::text,title,archived_at FROM web_media_items
 WHERE project_id=$1 AND ($2='' OR (created_at,id)<(SELECT created_at,id FROM web_media_items
 WHERE project_id=$1 AND id=NULLIF($2,'')::uuid)) ORDER BY created_at DESC,id DESC LIMIT 100`, r.PathValue("project"), before)
	if err != nil {
		internal(w, "list_web_media", err)
		return
	}
	items, err := pgx.CollectRows(rows, pgx.RowToStructByPos[webMediaItem])
	if err != nil {
		internal(w, "read_web_media", err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) createWebMedia(w http.ResponseWriter, r *http.Request, session Session) {
	var input struct {
		Title string `json:"title"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if !webText(input.Title, 160) {
		problem(w, http.StatusBadRequest, "invalid_media_title")
		return
	}
	projectID := r.PathValue("project")
	s.webWrite(w, r, session, Editor, false, http.StatusCreated, func(ctx context.Context, tx pgx.Tx, _ Role) (any, error) {
		item := webMediaItem{Title: strings.TrimSpace(input.Title)}
		err := tx.QueryRow(ctx, "INSERT INTO web_media_items(project_id,title) VALUES ($1,$2) RETURNING id::text", projectID, item.Title).Scan(&item.ID)
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
		Filename    string `json:"filename"`
		Bytes       int64  `json:"bytes"`
		Description string `json:"description"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	item, project := r.PathValue("item"), r.PathValue("project")
	kind := strings.TrimPrefix(strings.ToLower(filepath.Ext(input.Filename)), ".")
	if !uuidPattern.MatchString(item) || !webText(input.Filename, 200) ||
		strings.ContainsAny(input.Filename, "/\\\r\n") || utf8.RuneCountInString(input.Description) > 2000 ||
		strings.ContainsRune(input.Description, 0) || input.Bytes <= 0 || input.Bytes > webUploadLimit ||
		(kind != "wav" && kind != "mp3") {
		problem(w, http.StatusBadRequest, "invalid_upload")
		return
	}
	s.webWrite(w, r, session, Editor, false, http.StatusCreated, func(ctx context.Context, tx pgx.Tx, _ Role) (any, error) {
		var id string
		var expires time.Time
		err := tx.QueryRow(ctx, `INSERT INTO web_uploads(project_id,item_id,actor_id,filename,description,bytes,kind)
 SELECT $1,id,$3,$4,$5,$6,$7 FROM web_media_items WHERE project_id=$1 AND id=$2 AND archived_at IS NULL
 RETURNING id::text,expires_at`, project, item, session.AccountID, input.Filename, input.Description, input.Bytes, kind).Scan(&id, &expires)
		if err != nil {
			return nil, err
		}
		signing, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		request, err := s3.NewPresignClient(store.client).PresignPutObject(signing, &s3.PutObjectInput{
			Bucket: &store.bucket, Key: aws.String(webTemporaryKey(project, id)), ContentLength: &input.Bytes,
		}, s3.WithPresignExpires(webUploadWindow))
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
