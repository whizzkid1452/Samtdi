package collaboration

import (
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func seedNative(t *testing.T, pool *pgxpool.Pool, name string) (string, string) {
	t.Helper()
	var account string
	err := pool.QueryRow(t.Context(), `INSERT INTO accounts (issuer, subject, email) VALUES ('test', $1, $2) RETURNING id::text`,
		name, name+"@example.test").Scan(&account)
	if err != nil {
		t.Fatal(err)
	}

	token, err := createSession(t.Context(), pool, account, "native")
	if err != nil {
		t.Fatal(err)
	}

	return account, token
}

func seedProject(t *testing.T, pool *pgxpool.Pool, roles map[string]Role) string {
	t.Helper()
	var projectID string
	err := pool.QueryRow(t.Context(), `INSERT INTO projects (title) VALUES ('Git Test') RETURNING id::text`).Scan(&projectID)
	if err != nil {
		t.Fatal(err)
	}
	for account, role := range roles {
		if _, err := pool.Exec(t.Context(), `INSERT INTO memberships (project_id,account_id,role) VALUES ($1,$2,$3)`, projectID, account, role); err != nil {
			t.Fatal(err)
		}
	}

	return projectID
}

func gitClient(t *testing.T, executable, dir, token string, success bool, args ...string) string {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), executable, args...)
	cmd.Dir = dir
	cmd.Env = []string{"LC_ALL=C", "PATH=" + os.Getenv("PATH"), "HOME=" + dir, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.test", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.test"}
	if token != "" {
		credentials := base64.StdEncoding.EncodeToString([]byte("ayotbi:" + token))
		cmd.Env = append(cmd.Env, "GIT_CONFIG_COUNT=2", "GIT_CONFIG_KEY_0=http.extraHeader",
			"GIT_CONFIG_VALUE_0=Authorization: Basic "+credentials, "GIT_CONFIG_KEY_1=http.followRedirects", "GIT_CONFIG_VALUE_1=false")
	}
	output, err := cmd.CombinedOutput()
	if (err == nil) != success {
		t.Fatalf("git %s: %v: %s", args[0], err, output)
	}

	return string(output)
}

func TestGitSmartHTTP(t *testing.T) {
	pool := integrationPool(t)
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}

	repositories, err := NewGitRepositories(t.Context(), GitConfig{Root: filepath.Join(t.TempDir(), "repositories"), Executable: git})
	if err != nil {
		t.Fatal(err)
	}

	handler := &Server{pool: pool, mux: http.NewServeMux(), git: repositories}
	handler.routes()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	editor, editorToken := seedNative(t, pool, "git-editor")
	reader, readerToken := seedNative(t, pool, "git-reviewer")
	outsider, outsiderToken := seedNative(t, pool, "git-outsider")
	projectID := seedProject(t, pool, map[string]Role{editor: Owner, reader: Reviewer})
	otherID := seedProject(t, pool, map[string]Role{outsider: Owner})
	remote := server.URL + "/git/" + projectID + ".git"
	otherRemote := server.URL + "/git/" + otherID + ".git"

	base := t.TempDir()
	gitClient(t, git, base, "", false, "ls-remote", remote)
	gitClient(t, git, base, outsiderToken, false, "ls-remote", remote)
	response(t, server.Client(), "GET", remote+"/HEAD", editorToken, "", nil, 404, nil)
	response(t, server.Client(), "GET", remote+"/info/refs?service=git-upload-archive", editorToken, "", nil, 404, nil)
	response(t, server.Client(), "GET", remote+"/info/refs?service=git-receive-pack", readerToken, "", nil, 403, nil)
	response(t, server.Client(), "GET", otherRemote+"/info/refs?service=git-upload-pack", editorToken, "", nil, 404, nil)
	encodedRemote := server.URL + "/git/%" + hex.EncodeToString([]byte(projectID[:1])) + projectID[1:] + ".git"
	response(t, server.Client(), "GET", encodedRemote+"/info/refs?service=git-upload-pack", editorToken, "", nil, 404, nil)

	src := filepath.Join(base, "src")
	gitClient(t, git, base, editorToken, true, "clone", remote, src)
	if err := os.WriteFile(filepath.Join(src, "test.txt"), []byte("first"), 0600); err != nil {
		t.Fatal(err)
	}
	gitClient(t, git, src, "", true, "add", "test.txt")
	gitClient(t, git, src, "", true, "commit", "-m", "first")
	gitClient(t, git, src, editorToken, true, "push", "origin", "HEAD:refs/heads/main")

	clone := filepath.Join(base, "clone")
	gitClient(t, git, base, readerToken, true, "clone", remote, clone)
	raw, err := os.ReadFile(filepath.Join(clone, "test.txt"))
	if err != nil || string(raw) != "first" {
		t.Fatal("reader did not clone the expected commit")
	}
	gitClient(t, git, clone, readerToken, false, "push", "origin", "HEAD:refs/heads/blocked")

	if err := os.WriteFile(filepath.Join(src, "test.txt"), []byte("second"), 0600); err != nil {
		t.Fatal(err)
	}
	gitClient(t, git, src, "", true, "commit", "-am", "second")
	gitClient(t, git, src, editorToken, true, "-c", "http.postBuffer=64", "push", "origin", "HEAD:refs/heads/main")
	gitClient(t, git, clone, readerToken, true, "fetch", "origin")
	if output := gitClient(t, git, clone, "", true, "show", "origin/main:test.txt"); strings.TrimSpace(output) != "second" {
		t.Fatal("reader did not fetch the second commit")
	}

	if _, err := pool.Exec(t.Context(), `DELETE FROM memberships WHERE project_id = $1 AND account_id = $2`, projectID, reader); err != nil {
		t.Fatal(err)
	}
	gitClient(t, git, clone, readerToken, false, "fetch", "origin")
	if output := gitClient(t, git, base, outsiderToken, true, "ls-remote", otherRemote); output != "" {
		t.Fatal("second project exposed first project's refs")
	}
}
