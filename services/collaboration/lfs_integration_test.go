package collaboration

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

type storedTestBlob struct {
	bytes []byte
	oid   string
}

func testS3(t *testing.T) (*httptest.Server, func() int) {
	t.Helper()
	var mu sync.Mutex
	files := make(map[string]storedTestBlob)
	puts := 0
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") ||
			(!strings.HasPrefix(r.URL.Path, "/test-bucket/lfs/") && !strings.HasPrefix(r.URL.Path, "/test-bucket/review-media/")) {
			http.Error(w, "invalid S3 request", 403)
			return
		}

		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodPut {
			body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			digest := sha256.Sum256(body)
			oid := hex.EncodeToString(digest[:])
			if err != nil || r.Header.Get("X-Amz-Meta-Sha256") != oid ||
				r.Header.Get("X-Amz-Checksum-Sha256") != base64.StdEncoding.EncodeToString(digest[:]) ||
				!strings.HasSuffix(r.URL.Path, "/"+oid) {
				http.Error(w, "object integrity", 422)
				return
			}

			files[r.URL.Path] = storedTestBlob{bytes: body, oid: oid}
			puts++
			w.WriteHeader(http.StatusOK)
			return
		}

		blob, exists := files[r.URL.Path]
		if !exists {
			w.WriteHeader(http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Length", strconv.Itoa(len(blob.bytes)))
		w.Header().Set("X-Amz-Meta-Sha256", blob.oid)
		if r.Method == http.MethodGet {
			if raw := r.Header.Get("Range"); raw != "" {
				first, last, ok := parseAudioRange(raw, int64(len(blob.bytes)))
				if !ok {
					w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
					return
				}
				w.Header().Set("Content-Length", strconv.FormatInt(last-first+1, 10))
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", first, last, len(blob.bytes)))
				w.WriteHeader(http.StatusPartialContent)
				_, _ = w.Write(blob.bytes[first : last+1])
				return
			}
			digest := sha256.Sum256(blob.bytes)
			w.Header().Set("X-Amz-Checksum-Sha256", base64.StdEncoding.EncodeToString(digest[:]))
			_, _ = w.Write(blob.bytes)
		}
	})
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server, func() int {
		mu.Lock()
		defer mu.Unlock()
		return puts
	}
}

func testObjectStore(t *testing.T) (BlobStore, func() int) {
	t.Helper()
	s3server, writes := testS3(t)
	t.Setenv("AWS_ACCESS_KEY_ID", "test-access")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("AWS_SESSION_TOKEN", "")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	t.Setenv("AWS_CONFIG_FILE", filepath.Join(t.TempDir(), "aws-config"))
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", filepath.Join(t.TempDir(), "aws-credentials"))
	blobs, err := newS3Store(t.Context(), S3Config{Bucket: "test-bucket", Region: "us-east-1", Endpoint: s3server.URL}, true)
	if err != nil {
		t.Fatal(err)
	}
	return blobs, writes
}

func TestGitLFSObjectRoundTrip(t *testing.T) {
	pool := integrationPool(t)
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := exec.LookPath("git-lfs"); err != nil {
		t.Fatal("install Git LFS to run collaboration integration tests")
	}

	blobs, writes := testObjectStore(t)

	repositories, err := NewGitRepositories(t.Context(), GitConfig{Root: filepath.Join(t.TempDir(), "repos"), Executable: git})
	if err != nil {
		t.Fatal(err)
	}

	listener := httptest.NewUnstartedServer(nil)
	handler := &Server{pool: pool, origin: "http://" + listener.Listener.Addr().String(), mux: http.NewServeMux(), git: repositories, blobs: blobs}
	handler.routes()
	listener.Config.Handler = handler
	listener.Start()
	t.Cleanup(listener.Close)

	owner, ownerToken := seedNative(t, pool, "lfs-owner")
	reviewer, reviewerToken := seedNative(t, pool, "lfs-reviewer")
	projectID := seedProject(t, pool, map[string]Role{owner: Owner, reviewer: Reviewer})
	secondID := seedProject(t, pool, map[string]Role{owner: Owner})
	remote := listener.URL + "/git/" + projectID + ".git"
	other := listener.URL + "/git/" + secondID + ".git/info/lfs"

	root := t.TempDir()
	source := filepath.Join(root, "src")
	gitClient(t, git, root, ownerToken, true, "clone", remote, source)
	gitClient(t, git, source, "", true, "lfs", "install", "--local")
	gitClient(t, git, source, "", true, "lfs", "track", "*.bin")
	media := bytes.Repeat([]byte("test WAV data"), 512)
	if err := os.WriteFile(filepath.Join(source, "audio.bin"), media, 0600); err != nil {
		t.Fatal(err)
	}
	gitClient(t, git, source, "", true, "add", ".gitattributes", "audio.bin")
	gitClient(t, git, source, "", true, "commit", "-m", "LFS media")
	gitClient(t, git, source, ownerToken, true, "push", "origin", "HEAD:refs/heads/main")
	if writes() != 1 {
		t.Fatalf("expected one verified S3 write, got %d", writes())
	}

	digest := sha256.Sum256(media)
	object := lfsObject{OID: hex.EncodeToString(digest[:]), Size: int64(len(media))}
	payload := map[string]any{"operation": "upload", "objects": []lfsObject{object}}
	var duplicate struct {
		Objects []lfsBatchItem `json:"objects"`
	}
	response(t, listener.Client(), "POST", remote+"/info/lfs/objects/batch", ownerToken, "", payload, 200, &duplicate)
	if len(duplicate.Objects) != 1 || duplicate.Objects[0].Actions != nil || writes() != 1 {
		t.Fatal("verified object was not deduplicated")
	}
	response(t, listener.Client(), "POST", remote+"/info/lfs/objects/batch", reviewerToken, "", payload, 403, nil)
	response(t, listener.Client(), "GET", other+"/objects/"+object.OID, ownerToken, "", nil, 404, nil)
	response(t, listener.Client(), "GET", remote+"/info/lfs/objects/"+object.OID, "", "", nil, 401, nil)

	dest := filepath.Join(root, "reader")
	gitClient(t, git, root, reviewerToken, true, "clone", remote, dest)
	gitClient(t, git, dest, "", true, "lfs", "install", "--local")
	gitClient(t, git, dest, reviewerToken, true, "lfs", "pull")
	restored, err := os.ReadFile(filepath.Join(dest, "audio.bin"))
	if err != nil || !bytes.Equal(restored, media) {
		t.Fatal("Git LFS did not materialize the verified media")
	}

	interrupted, err := http.NewRequestWithContext(t.Context(), http.MethodPut,
		other+"/objects/"+object.OID+"?size="+strconv.FormatInt(object.Size, 10), bytes.NewReader(media[:32]))
	if err != nil {
		t.Fatal(err)
	}
	interrupted.ContentLength = object.Size
	interrupted.SetBasicAuth("ayotbi", ownerToken)
	aborted, err := listener.Client().Do(interrupted)
	if aborted != nil {
		aborted.Body.Close()
	}
	if err == nil && (aborted == nil || aborted.StatusCode == 200) {
		t.Fatal("partial LFS upload succeeded")
	}
	response(t, listener.Client(), "GET", other+"/objects/"+object.OID, ownerToken, "", nil, 404, nil)
	if writes() != 1 {
		t.Fatal("interrupted upload published bytes")
	}

	corrupt, err := http.NewRequestWithContext(t.Context(), http.MethodPut,
		other+"/objects/"+object.OID+"?size="+strconv.FormatInt(object.Size, 10), bytes.NewReader(bytes.Repeat([]byte{0}, len(media))))
	if err != nil {
		t.Fatal(err)
	}
	corrupt.SetBasicAuth("ayotbi", ownerToken)
	rejected, err := listener.Client().Do(corrupt)
	if err != nil {
		t.Fatal(err)
	}
	rejected.Body.Close()
	if rejected.StatusCode != 422 || writes() != 1 {
		t.Fatal("corrupt bytes were written")
	}
	if _, err := pool.Exec(t.Context(), `DELETE FROM memberships WHERE project_id = $1 AND account_id = $2`, projectID, reviewer); err != nil {
		t.Fatal(err)
	}
	response(t, listener.Client(), "GET", remote+"/info/lfs/objects/"+object.OID, reviewerToken, "", nil, 404, nil)
}
