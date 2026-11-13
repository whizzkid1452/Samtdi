package collaboration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	lfsObjectLimit     int64 = 2 << 30
	lfsBatchLimit            = 100
	lfsTransferTimeout       = 20 * time.Minute
	lfsContentType           = "application/vnd.git-lfs+json"
)

var lfsOID = regexp.MustCompile(`^[0-9a-f]{64}$`)

type lfsObject struct {
	OID  string `json:"oid"`
	Size int64  `json:"size"`
}

func (object lfsObject) valid() bool {
	return lfsOID.MatchString(object.OID) && object.Size >= 0 && object.Size <= lfsObjectLimit
}

func lfsKey(projectID, oid string) string {
	return "lfs/" + projectID + "/" + oid[:2] + "/" + oid
}

type lfsAction struct {
	Href   string            `json:"href"`
	Header map[string]string `json:"header,omitempty"`
}

type lfsItemError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type lfsBatchItem struct {
	lfsObject
	Authenticated bool                 `json:"authenticated"`
	Actions       map[string]lfsAction `json:"actions,omitempty"`
	Error         *lfsItemError        `json:"error,omitempty"`
}

func (s *Server) lfsHTTP(w http.ResponseWriter, r *http.Request, session Session, projectID, operation string) {
	if s.blobs == nil {
		problem(w, http.StatusNotFound, "lfs_not_available")
		return
	}

	oid, isObject := strings.CutPrefix(operation, "info/lfs/objects/")
	isBatch := operation == "info/lfs/objects/batch" && r.Method == http.MethodPost
	isVerify := operation == "info/lfs/verify" && r.Method == http.MethodPost
	isUpload := isObject && lfsOID.MatchString(oid) && r.Method == http.MethodPut
	isDownload := isObject && lfsOID.MatchString(oid) && r.Method == http.MethodGet
	if !(isBatch || isVerify || isUpload || isDownload) || (!isUpload && r.URL.RawQuery != "") {
		problem(w, http.StatusNotFound, "lfs_operation_not_found")
		return
	}

	role, err := readRole(r.Context(), s.pool, projectID, session.AccountID)
	if !requireRole(w, role, err, (isBatch || isDownload) || role.canWrite()) {
		return
	}

	select {
	case s.lfsSlots <- struct{}{}:
		defer func() { <-s.lfsSlots }()
	default:
		problem(w, http.StatusServiceUnavailable, "lfs_busy")
		return
	}

	budget := lfsTransferTimeout
	if isBatch || isVerify {
		budget = 45 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), budget)
	defer cancel()
	deadline, _ := ctx.Deadline()
	control := http.NewResponseController(w)
	_ = control.SetReadDeadline(deadline)
	_ = control.SetWriteDeadline(deadline)
	r = r.WithContext(ctx)

	switch {
	case isBatch:
		s.lfsBatch(w, r, projectID, role)
	case isVerify:
		s.lfsVerify(w, r, projectID)
	case isUpload:
		s.lfsUpload(w, r, session, projectID, oid)
	case isDownload:
		s.lfsDownload(w, r, projectID, oid)
	}
}

func (s *Server) lfsBatch(w http.ResponseWriter, r *http.Request, projectID string, role Role) {
	var input struct {
		Operation string      `json:"operation"`
		Transfers []string    `json:"transfers"`
		Objects   []lfsObject `json:"objects"`
		Ref       *struct {
			Name string `json:"name"`
		} `json:"ref"`
		HashAlgo string `json:"hash_algo"`
	}
	if !readJSON(w, r, &input) {
		return
	}

	upload := input.Operation == "upload"
	if (!upload && input.Operation != "download") ||
		(len(input.Transfers) > 0 && !slices.Contains(input.Transfers, "basic")) ||
		(input.HashAlgo != "" && input.HashAlgo != "sha256") ||
		len(input.Objects) == 0 || len(input.Objects) > lfsBatchLimit {
		problem(w, http.StatusBadRequest, "invalid_lfs_batch")
		return
	}
	if upload && !role.canWrite() {
		problem(w, http.StatusForbidden, "insufficient_role")
		return
	}

	base := s.origin + "/git/" + projectID + ".git/info/lfs"
	auth := map[string]string{"Authorization": r.Header.Get("Authorization")}
	items := make([]lfsBatchItem, 0, len(input.Objects))
	for _, object := range input.Objects {
		item := lfsBatchItem{lfsObject: object, Authenticated: true}
		if !object.valid() {
			item.Error = &lfsItemError{Code: 422, Message: "invalid object metadata"}
			items = append(items, item)
			continue
		}

		exists, err := s.hasLFSObject(r.Context(), projectID, object)
		if err != nil {
			internal(w, "lfs_batch_object", err)
			return
		}

		href := base + "/objects/" + object.OID
		switch {
		case upload && !exists:
			item.Actions = map[string]lfsAction{
				"upload": {Href: href + "?size=" + strconv.FormatInt(object.Size, 10), Header: auth},
				"verify": {Href: base + "/verify", Header: auth},
			}
		case !upload && exists:
			item.Actions = map[string]lfsAction{"download": {Href: href, Header: auth}}
		case !upload:
			item.Error = &lfsItemError{Code: 404, Message: "object not found"}
		}

		items = append(items, item)
	}

	w.Header().Set("Content-Type", lfsContentType)
	writeJSON(w, http.StatusOK, map[string]any{"transfer": "basic", "hash_algo": "sha256", "objects": items})
}

func (s *Server) hasLFSObject(ctx context.Context, projectID string, object lfsObject) (bool, error) {
	var size int64
	err := s.pool.QueryRow(ctx, `SELECT size FROM lfs_objects WHERE project_id = $1 AND oid = $2`, projectID, object.OID).Scan(&size)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && size != object.Size) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	actual, err := s.blobs.Head(ctx, lfsKey(projectID, object.OID))
	if errors.Is(err, errBlobMissing) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	return actual.Size == size && actual.SHA256 == object.OID, nil
}

func (s *Server) lfsUpload(w http.ResponseWriter, r *http.Request, session Session, projectID, oid string) {
	size, err := strconv.ParseInt(r.URL.Query().Get("size"), 10, 64)
	object := lfsObject{OID: oid, Size: size}
	if err != nil || r.URL.RawQuery != "size="+strconv.FormatInt(size, 10) || !object.valid() ||
		(r.ContentLength >= 0 && r.ContentLength != size) || r.Header.Get("Content-Encoding") != "" {
		problem(w, http.StatusUnprocessableEntity, "invalid_lfs_size")
		return
	}

	file, err := os.CreateTemp("", "ayotbi-lfs-")
	if err != nil {
		internal(w, "lfs_stage", err)
		return
	}
	defer os.Remove(file.Name())
	defer file.Close()

	digest := sha256.New()
	written, err := io.Copy(io.MultiWriter(file, digest), http.MaxBytesReader(w, r.Body, size))
	var limit *http.MaxBytesError
	if errors.As(err, &limit) || (err == nil && written != size) {
		problem(w, http.StatusUnprocessableEntity, "lfs_size_mismatch")
		return
	}
	if err != nil {
		internal(w, "lfs_receive", err)
		return
	}
	if hex.EncodeToString(digest.Sum(nil)) != oid {
		problem(w, http.StatusUnprocessableEntity, "lfs_hash_mismatch")
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		internal(w, "lfs_rewind", err)
		return
	}

	ctx := r.Context()
	if !s.requireGitWrite(w, ctx, projectID, session) {
		return
	}

	exists, err := s.hasLFSObject(ctx, projectID, object)
	if err != nil {
		internal(w, "lfs_existing_object", err)
		return
	}
	if !exists {
		if err := s.blobs.Put(ctx, lfsKey(projectID, oid), BlobMetadata{Size: size, SHA256: oid}, file); err != nil {
			internal(w, "lfs_store", err)
			return
		}

		tag, err := s.pool.Exec(ctx, `INSERT INTO lfs_objects (project_id, oid, size)
  SELECT $1::uuid, $2, $3 FROM memberships m JOIN sessions s ON s.account_id = m.account_id
  WHERE m.project_id = $1 AND m.account_id = $4 AND s.token_hash = $5 AND s.expires_at > now() AND m.role IN ('editor','owner')
  ON CONFLICT (project_id, oid) DO UPDATE SET verified_at = now() WHERE lfs_objects.size = EXCLUDED.size`,
			projectID, oid, size, session.AccountID, session.tokenHash)
		if err != nil {
			internal(w, "lfs_commit", err)
			return
		}
		if tag.RowsAffected() != 1 {
			problem(w, http.StatusConflict, "lfs_object_unavailable")
			return
		}
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) lfsVerify(w http.ResponseWriter, r *http.Request, projectID string) {
	var object lfsObject
	if !readJSON(w, r, &object) {
		return
	}
	if !object.valid() {
		problem(w, http.StatusUnprocessableEntity, "invalid_lfs_object")
		return
	}

	exists, err := s.hasLFSObject(r.Context(), projectID, object)
	if err != nil {
		internal(w, "lfs_verify", err)
		return
	}
	if !exists {
		problem(w, http.StatusNotFound, "lfs_object_not_found")
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) lfsDownload(w http.ResponseWriter, r *http.Request, projectID, oid string) {
	ctx := r.Context()
	var size int64
	err := s.pool.QueryRow(ctx, `SELECT size FROM lfs_objects WHERE project_id = $1 AND oid = $2`, projectID, oid).Scan(&size)
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, http.StatusNotFound, "lfs_object_not_found")
		return
	}
	if err != nil {
		internal(w, "lfs_read_index", err)
		return
	}

	stream, metadata, err := s.blobs.Open(ctx, lfsKey(projectID, oid))
	if errors.Is(err, errBlobMissing) {
		problem(w, http.StatusNotFound, "lfs_object_not_found")
		return
	}
	if err != nil {
		internal(w, "lfs_open_object", err)
		return
	}
	defer stream.Close()
	if metadata.Size != size || metadata.SHA256 != oid {
		problem(w, http.StatusConflict, "lfs_object_mismatch")
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.CopyN(w, stream, size)
}
