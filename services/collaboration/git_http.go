package collaboration

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

const (
	uploadPack     = "git-upload-pack"
	receivePack    = "git-receive-pack"
	gitHeaderLimit = 32 << 10
)

func (s *Server) withGitSession(handler sessionHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		session, err := s.authenticate(r, true)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && session.Kind != "native") {
			w.Header().Set("WWW-Authenticate", `Basic realm="Ayotbi"`)
			problem(w, http.StatusUnauthorized, "authentication_required")
			return
		}
		if err != nil {
			internal(w, "authenticate_git", err)
			return
		}

		handler(w, r, session)
	}
}

func (s *Server) gitHTTP(w http.ResponseWriter, r *http.Request, session Session) {
	repository := r.PathValue("repository")
	operation := r.PathValue("operation")
	projectID, suffix := strings.CutSuffix(repository, ".git")
	canonical := "/git/" + repository + "/" + operation
	if !suffix || !uuidPattern.MatchString(projectID) || r.URL.EscapedPath() != canonical {
		problem(w, http.StatusNotFound, "repository_not_found")
		return
	}

	if strings.HasPrefix(operation, "info/lfs/") {
		s.lfsHTTP(w, r, session, projectID, operation)
		return
	}

	service, ok := requestedGitService(r, operation)
	if !ok {
		problem(w, http.StatusNotFound, "git_operation_not_found")
		return
	}

	if encoding := r.Header.Get("Content-Encoding"); encoding != "" && (service != uploadPack || encoding != "gzip") {
		problem(w, http.StatusUnsupportedMediaType, "unsupported_content_encoding")
		return
	}

	role, err := readRole(r.Context(), s.pool, projectID, session.AccountID)
	if !requireRole(w, role, err, service == uploadPack || role.canWrite()) {
		return
	}

	slots := s.git.slots
	select {
	case slots <- struct{}{}:
		defer func() { <-slots }()
	default:
		problem(w, http.StatusServiceUnavailable, "git_busy")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), gitTransferLimit)
	defer cancel()
	response := http.NewResponseController(w)
	deadline, _ := ctx.Deadline()
	_ = response.SetReadDeadline(deadline)
	_ = response.SetWriteDeadline(deadline)

	var body *os.File
	var size int64
	if r.Method == http.MethodPost {
		if r.ContentLength > gitPackLimit {
			problem(w, http.StatusRequestEntityTooLarge, "git_pack_too_large")
			return
		}
		body, err = os.CreateTemp("", "ayotbi-git-pack-")
		if err != nil {
			internal(w, "stage_git_request", err)
			return
		}
		defer os.Remove(body.Name())
		defer body.Close()

		size, err = io.Copy(body, http.MaxBytesReader(w, r.Body, gitPackLimit))
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			problem(w, http.StatusRequestEntityTooLarge, "git_pack_too_large")
			return
		}
		if err != nil {
			problem(w, http.StatusBadRequest, "incomplete_git_request")
			return
		}
		if _, err := body.Seek(0, io.SeekStart); err != nil {
			internal(w, "read_git_request", err)
			return
		}
	}

	repo, err := s.git.repository(ctx, projectID)
	if err != nil {
		internal(w, "prepare_git_repository", err)
		return
	}

	path := "/" + repository + "/" + operation
	if service == receivePack && r.Method == http.MethodPost {
		if s.receive != nil {
			s.guardedReceive(ctx, w, r, session, projectID, repo, path, body, size)
			return
		}
		if !s.requireGitWrite(w, ctx, projectID, session) {
			return
		}
	}

	s.git.serveBackend(ctx, w, r, session, path, body, size, nil)
}

func (s *Server) requireGitWrite(w http.ResponseWriter, ctx context.Context, projectID string, session Session) bool {
	var role Role
	err := s.pool.QueryRow(ctx, `SELECT m.role FROM memberships m
 JOIN sessions s ON s.account_id = m.account_id
 WHERE m.project_id = $1 AND m.account_id = $2 AND s.token_hash = $3 AND s.kind = 'native' AND s.expires_at > now()`,
		projectID, session.AccountID, session.tokenHash).Scan(&role)
	return requireRole(w, role, err, role.canWrite())
}

func requestedGitService(r *http.Request, operation string) (string, bool) {
	if r.Method == http.MethodGet && operation == "info/refs" {
		switch r.URL.RawQuery {
		case "service=" + uploadPack:
			return uploadPack, true
		case "service=" + receivePack:
			return receivePack, true
		}
	}
	if r.Method == http.MethodPost && r.URL.RawQuery == "" && (operation == uploadPack || operation == receivePack) &&
		r.Header.Get("Content-Type") == "application/x-"+operation+"-request" {
		return operation, true
	}

	return "", false
}

func (g *GitRepositories) serveBackend(ctx context.Context, w http.ResponseWriter, r *http.Request, session Session, path string, body *os.File, size int64, hookEnv []string) bool {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	cmd := gitCommand(ctx, g.backend, g.root)
	cmd.Env = append(cmd.Env, "GIT_PROJECT_ROOT="+g.root, "GIT_HTTP_EXPORT_ALL=1", "REMOTE_USER="+session.AccountID,
		"GIT_EXEC_PATH="+strings.TrimSuffix(g.backend, "/git-http-backend"), "REQUEST_METHOD="+r.Method,
		"PATH_INFO="+path, "QUERY_STRING="+r.URL.RawQuery, "CONTENT_TYPE="+r.Header.Get("Content-Type"),
		"CONTENT_LENGTH="+strconv.FormatInt(size, 10))
	cmd.Env = append(cmd.Env, "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=transfer.hideRefs", "GIT_CONFIG_VALUE_0=refs/ayotbi/")
	cmd.Env = append(cmd.Env, hookEnv...)
	if r.Header.Get("Content-Encoding") == "gzip" {
		cmd.Env = append(cmd.Env, "HTTP_CONTENT_ENCODING=gzip")
	}
	if protocol := r.Header.Get("Git-Protocol"); protocol == "version=2" || protocol == "version=1" {
		cmd.Env = append(cmd.Env, "HTTP_GIT_PROTOCOL="+protocol)
	}
	if body != nil {
		cmd.Stdin = body
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		internal(w, "prepare_git_backend", err)
		return false
	}
	if err := cmd.Start(); err != nil {
		stdout.Close()
		internal(w, "start_git_backend", err)
		return false
	}

	reader := bufio.NewReaderSize(stdout, gitHeaderLimit)
	status, contentType, err := readGitHeaders(reader)
	if err != nil {
		cancel()
		_ = cmd.Wait()
		problem(w, http.StatusBadGateway, "git_backend_failed")
		return false
	}

	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(status)
	if _, err := io.Copy(w, reader); err != nil {
		cancel()
	}
	return cmd.Wait() == nil
}

func readGitHeaders(reader *bufio.Reader) (int, string, error) {
	status := http.StatusOK
	var contentType string
	budget := gitHeaderLimit
	for budget > 0 {
		line, err := reader.ReadSlice('\n')
		budget -= len(line)
		if err != nil || budget < 0 {
			break
		}

		raw := strings.TrimRight(string(line), "\r\n")
		if raw == "" {
			return status, contentType, nil
		}

		name, value, ok := strings.Cut(raw, ":")
		if !ok {
			break
		}
		value = strings.TrimSpace(value)
		switch strings.ToLower(name) {
		case "status":
			code, _, _ := strings.Cut(value, " ")
			status, err = strconv.Atoi(code)
			if err != nil || status < 200 || status >= 600 {
				return 0, "", errors.New("invalid Git backend status")
			}
		case "content-type":
			if strings.HasPrefix(value, "application/x-git-") || value == "text/plain" {
				contentType = value
			}
		}
	}

	return 0, "", errors.New("invalid Git backend headers")
}
