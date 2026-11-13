package collaboration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if filepath.Base(os.Args[0]) == "pre-receive" {
		if err := RunReceiveHook(context.Background(), os.Stdin, os.Stderr); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		return
	}

	os.Exit(m.Run())
}

func TestReceiveProtectsSharedVersions(t *testing.T) {
	pool := integrationPool(t)
	documentPath := os.Getenv("AYOTBI_TEST_PROJECT_DOCUMENT")
	executable := os.Getenv("AYOTBI_TEST_PROJECT_TOOL")
	if documentPath == "" || executable == "" {
		t.Skip("set AYOTBI_TEST_PROJECT_TOOL and AYOTBI_TEST_PROJECT_DOCUMENT")
	}

	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	tool, err := NewProjectTool(executable)
	if err != nil {
		t.Fatal(err)
	}
	hook, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	repositories, err := NewGitRepositories(t.Context(), GitConfig{Root: filepath.Join(root, "repos"), Executable: git})
	if err != nil {
		t.Fatal(err)
	}

	blobs, _ := testObjectStore(t)
	listener := httptest.NewUnstartedServer(nil)
	handler := &Server{pool: pool, origin: "http://" + listener.Listener.Addr().String(), mux: http.NewServeMux(),
		git: repositories, blobs: blobs, projectTool: tool}
	handler.receive, err = startReceiveGate(hook, 2, handler.validateReceive)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := handler.Close(); err != nil {
			t.Error(err)
		}
	})
	if worker := os.Getenv("AYOTBI_TEST_RENDER_WORKER"); worker != "" {
		handler.renderer, err = newReviewRenderer(RendererConfig{Executable: worker})
		if err != nil {
			t.Fatal(err)
		}
	}
	handler.routes()
	previewDestination := os.Getenv("AYOTBI_TEST_WEB_PREVIEW")
	if previewDestination != "" {
		handler.mux.HandleFunc("GET /test-preview/{session}", func(w http.ResponseWriter, r *http.Request) {
			token := r.PathValue("session")
			if !tokenPattern.MatchString(token) || !safeReviewReturn(r.URL.Query().Get("target")) {
				http.NotFound(w, r)
				return
			}
			http.SetCookie(w, handler.cookie(webSessionCookie, token, time.Hour))
			http.Redirect(w, r, r.URL.Query().Get("target"), http.StatusSeeOther)
		})
	}

	listener.Config.Handler = handler
	listener.Start()
	t.Cleanup(listener.Close)

	owner, ownerToken := seedNative(t, pool, "receive-owner")
	editor, editorToken := seedNative(t, pool, "receive-editor")
	projectID := seedProject(t, pool, map[string]Role{owner: Owner, editor: Editor})
	remote := listener.URL + "/git/" + projectID + ".git"

	source := filepath.Join(root, "clone")
	gitClient(t, git, root, ownerToken, true, "clone", remote, source)

	input, err := os.ReadFile(documentPath)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(input, &document); err != nil {
		t.Fatal(err)
	}
	document["trackOrder"] = []string{}
	for _, field := range []string{"tracks", "assets", "audioClips", "patterns", "midiClips", "plugins", "routes", "automation"} {
		document[field] = map[string]any{}
	}

	encode := func() []byte {
		t.Helper()
		raw, err := json.Marshal(document)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	writeFile := func(name string, contents []byte) {
		t.Helper()
		path := filepath.Join(source, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, contents, 0600); err != nil {
			t.Fatal(err)
		}
	}
	commit := func(message string) {
		t.Helper()
		gitClient(t, git, source, "", true, "add", "-f", ".")
		gitClient(t, git, source, "", true, "commit", "-m", message)
	}

	initial := encode()
	result, err := tool.VersionManifest(t.Context(), initial)
	if err != nil || !result.OK {
		t.Fatalf("fixture manifest: %v", err)
	}
	var manifest versionManifest
	if err := json.Unmarshal(result.Document, &manifest); err != nil {
		t.Fatal(err)
	}
	for path, contents := range manifest.Metadata {
		writeFile(path, []byte(contents))
	}
	writeFile("project.json", initial)
	commit("first project")
	first := strings.TrimSpace(gitClient(t, git, source, "", true, "rev-parse", "HEAD"))

	reject := func(token, ref, reason string) {
		t.Helper()
		output := gitClient(t, git, source, token, false, "push", "origin", ref)
		if !strings.Contains(output, reason) {
			t.Fatalf("expected %s, got %s", reason, output)
		}
	}
	reject(editorToken, "HEAD:refs/heads/main", "shared_branch_protected")
	gitClient(t, git, source, ownerToken, true, "push", "origin", "HEAD:refs/heads/main")

	document["name"] = "changed name"
	writeFile("project.json", encode())
	commit("edit project")
	reject(ownerToken, "HEAD:refs/heads/main", "shared_branch_protected")
	gitClient(t, git, source, editorToken, true, "push", "origin", "HEAD:refs/heads/variation")
	reject(ownerToken, ":refs/heads/main", "shared_branch_protected")

	writeFile("project.json", []byte("{}"))
	commit("invalid intermediate")
	writeFile("project.json", initial)
	commit("valid tip")
	reject(editorToken, "HEAD:refs/heads/invalid-ancestry", "invalid_project_version")
	gitClient(t, git, source, "", true, "reset", "--hard", first)

	media := []byte("RIFF\x26\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x80\xbb\x00\x00\x00\x77\x01\x00\x02\x00\x10\x00data\x02\x00\x00\x00\x00\x00")
	hash := sha256.Sum256(media)
	oid := hex.EncodeToString(hash[:])
	document["assets"] = map[string]any{oid: map[string]any{"channels": 1, "lengthSamples": 1, "sampleRateHz": 48000}}
	writeFile("project.json", encode())
	writeFile("assets/"+oid+".wav", []byte(fmt.Sprintf("version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %d\n", oid, len(media))))
	commit("asset version")
	reject(editorToken, "HEAD:refs/heads/with-media", "required_lfs_object_missing")

	request, err := http.NewRequestWithContext(t.Context(), http.MethodPut,
		remote+"/info/lfs/objects/"+oid+"?size="+strconv.Itoa(len(media)), bytes.NewReader(media))
	if err != nil {
		t.Fatal(err)
	}
	request.SetBasicAuth("ayotbi", editorToken)
	stored, err := listener.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	stored.Body.Close()
	if stored.StatusCode != 200 {
		t.Fatalf("LFS upload status %d", stored.StatusCode)
	}
	gitClient(t, git, source, editorToken, true, "push", "origin", "HEAD:refs/heads/with-media")

	refs := gitClient(t, git, source, ownerToken, true, "ls-remote", remote)
	if !strings.Contains(refs, first+"\trefs/heads/main") || !strings.Contains(refs, "refs/heads/with-media") ||
		strings.Contains(refs, "refs/heads/invalid-ancestry") {
		t.Fatalf("unexpected refs: %s", refs)
	}

	if version := os.Getenv("AYOTBI_TEST_VERSION_TOOL"); version != "" {
		t.Run("desktop_transfer_core", func(t *testing.T) {
			candidate := filepath.Join(root, "verified-copy")
			runVersion := func(verb, token, branch string, ok bool) {
				t.Helper()
				command := exec.CommandContext(t.Context(), version, verb, candidate, listener.URL, projectID, branch)
				command.Env = append(os.Environ(), "AYOTBI_REMOTE_TOKEN="+token)
				output, err := command.CombinedOutput()
				if (err == nil) != ok || bytes.Contains(output, []byte(token)) {
					t.Fatalf("native transfer %s failed: %v, %s", verb, err, output)
				}
			}

			runVersion("remote-pull", editorToken, "with-media", true)
			actual, err := os.ReadFile(filepath.Join(candidate, "assets", oid+".wav"))
			if err != nil || !bytes.Equal(actual, media) {
				t.Fatal("desktop pull did not materialize media")
			}

			documentPath := filepath.Join(candidate, "project.json")
			raw, err := os.ReadFile(documentPath)
			if err != nil {
				t.Fatal(err)
			}
			draft := append(raw, '\n')
			if err := os.WriteFile(documentPath, draft, 0600); err != nil {
				t.Fatal(err)
			}

			head := gitClient(t, git, candidate, "", true, "rev-parse", "HEAD")
			runVersion("remote-fetch", editorToken, "variation", true)
			runVersion("remote-push", editorToken, "native-variation", true)
			runVersion("remote-pull", editorToken, "variation", false)
			unchanged, err := os.ReadFile(documentPath)
			if err != nil || !bytes.Equal(draft, unchanged) || gitClient(t, git, candidate, "", true, "rev-parse", "HEAD") != head {
				t.Fatal("fetch, push or rejected pull overwrote the current workspace")
			}
		})
	}

	t.Run("pinned_reviews", func(t *testing.T) {
		reviewer, reviewerToken := seedNative(t, pool, "receive-reviewer")
		if _, err := pool.Exec(t.Context(), `INSERT INTO memberships VALUES ($1,$2,'reviewer')`, projectID, reviewer); err != nil {
			t.Fatal(err)
		}
		_, outsiderToken := seedNative(t, pool, "review-outsider")

		endpoint := listener.URL + "/v1/projects/" + projectID + "/reviews"
		newReview := func(branch string) review {
			t.Helper()
			var target review
			response(t, listener.Client(), "POST", endpoint, editorToken, "", map[string]string{"title": "테스트 리뷰", "source_branch": branch}, 201, &target)
			return target
		}
		old := newReview("variation")
		if old.BaseOID != first || old.HeadOID == first || old.State != "open" {
			t.Fatal("review did not pin two commits")
		}
		reviewURL := endpoint + "/" + old.ID

		response(t, listener.Client(), "GET", reviewURL, outsiderToken, "", nil, 404, nil)
		var comment reviewComment
		response(t, listener.Client(), "POST", reviewURL+"/comments", reviewerToken, "",
			map[string]any{"body": "리뷰 댓글", "commit_oid": old.HeadOID, "position_ticks": 480}, 201, &comment)
		response(t, listener.Client(), "POST", reviewURL+"/comments", reviewerToken, "",
			map[string]any{"body": "wrong commit", "commit_oid": zeroCommit}, 400, nil)
		if comment.CommitOID != old.HeadOID || comment.PositionTicks == nil || *comment.PositionTicks != 480 {
			t.Fatal("comment lost pinned location")
		}

		gitClient(t, git, source, editorToken, true, "push", "origin", ":refs/heads/variation")
		response(t, listener.Client(), "GET", reviewURL, reviewerToken, "", nil, 200, &old)
		if old.State != "stale" {
			t.Fatal("deleted branch review did not become stale")
		}
		response(t, listener.Client(), "POST", reviewURL+"/merge", ownerToken, "", nil, 409, nil)
		var diff struct {
			HeadOID string     `json:"head_oid"`
			Diff    ToolResult `json:"diff"`
		}
		response(t, listener.Client(), "GET", reviewURL+"/diff", reviewerToken, "", nil, 200, &diff)
		if diff.HeadOID != comment.CommitOID || !diff.Diff.OK {
			t.Fatal("pinned diff was lost after deletion")
		}
		var comments []reviewComment
		response(t, listener.Client(), "GET", reviewURL+"/comments", reviewerToken, "", nil, 200, &comments)
		if len(comments) != 1 || comments[0].ID != comment.ID {
			t.Fatal("older comment was lost")
		}

		current := newReview("with-media")
		currentURL := endpoint + "/" + current.ID
		var preview struct {
			Validation string `json:"validation"`
		}
		response(t, listener.Client(), "POST", currentURL+"/validate", editorToken, "", nil, 200, &preview)
		if preview.Validation != "clean" {
			t.Fatal("unexpected merge validation status")
		}
		response(t, listener.Client(), "POST", currentURL+"/merge", editorToken, "", nil, 403, nil)
		var merged review
		response(t, listener.Client(), "POST", currentURL+"/merge", ownerToken, "", nil, 200, &merged)
		if merged.State != "merged" || !gitOID.MatchString(merged.MergedOID) {
			t.Fatal("merge was not recorded")
		}
		bare, err := repositories.repository(t.Context(), projectID)
		if err != nil {
			t.Fatal(err)
		}
		parents := strings.Fields(gitClient(t, git, bare, "", true, "rev-list", "--parents", "-n", "1", sharedBranch))
		if len(parents) != 3 || parents[0] != merged.MergedOID || parents[1] != first || parents[2] != current.HeadOID {
			t.Fatal("shared merge has incorrect parents")
		}
		if _, err := pool.Exec(t.Context(), `UPDATE reviews SET merged_oid = NULL WHERE id = $1`, current.ID); err != nil {
			t.Fatal(err)
		}
		var recovered review
		response(t, listener.Client(), "GET", currentURL, reviewerToken, "", nil, 200, &recovered)
		if recovered.State != "merged" || recovered.MergedOID != merged.MergedOID {
			t.Fatal("persisted intent did not reconcile")
		}

		if handler.renderer != nil {
			t.Run("review_render", func(t *testing.T) {
				queue := func(path, commit string) reviewMedia {
					t.Helper()
					var media reviewMedia
					response(t, listener.Client(), "POST", path+"/media", editorToken, "",
						map[string]any{"commit_oid": commit, "begin_seconds": 0, "end_seconds": 0.25}, 202, &media)
					return media
				}
				finish := func(path string) []reviewMedia {
					t.Helper()
					worked, err := handler.workReviewRender(t.Context())
					if err != nil || !worked {
						t.Fatalf("render job did not run: %v", err)
					}
					var versions []reviewMedia
					response(t, listener.Client(), "GET", path+"/media", reviewerToken, "", nil, 200, &versions)
					return versions
				}

				queued := queue(currentURL, current.HeadOID)
				duplicate := queue(currentURL, current.HeadOID)
				if queued.State != "queued" || duplicate.ID != queued.ID {
					t.Fatal("render was not queued idempotently")
				}
				versions := finish(currentURL)
				if len(versions) != 1 || versions[0].State != "ready" || versions[0].CommitOID != current.HeadOID || versions[0].MixBytes <= 44 {
					t.Fatalf("review did not produce a verified WAV: %+v", versions)
				}

				request, err := http.NewRequestWithContext(t.Context(), "GET", currentURL+"/media/"+queued.ID+"/wav", nil)
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set("Authorization", "Bearer "+reviewerToken)
				downloaded, err := listener.Client().Do(request)
				if err != nil {
					t.Fatal(err)
				}
				defer downloaded.Body.Close()
				actual, err := io.ReadAll(downloaded.Body)
				digest := sha256.Sum256(actual)
				if err != nil || downloaded.StatusCode != 200 || !bytes.HasPrefix(actual, []byte("RIFF")) ||
					hex.EncodeToString(digest[:]) != versions[0].MixOID {
					t.Fatal("review WAV bytes do not match media version")
				}

				ranged, err := http.NewRequestWithContext(t.Context(), "GET", currentURL+"/media/"+queued.ID+"/wav", nil)
				if err != nil {
					t.Fatal(err)
				}
				ranged.Header.Set("Authorization", "Bearer "+reviewerToken)
				ranged.Header.Set("Range", "bytes=0-11")
				part, err := listener.Client().Do(ranged)
				if err != nil {
					t.Fatal(err)
				}
				prefix, err := io.ReadAll(part.Body)
				part.Body.Close()
				if err != nil || part.StatusCode != 206 || !bytes.Equal(prefix, actual[:12]) {
					t.Fatal("authorized audio byte range did not match WAV")
				}

				queue(currentURL, current.BaseOID)
				pair := finish(currentURL)
				if len(pair) != 2 || pair[0].State != "ready" || pair[1].State != "ready" {
					t.Fatal("two sides did not render")
				}

				webToken, err := createSession(t.Context(), pool, owner, "web")
				if err != nil {
					t.Fatal(err)
				}
				webPath := "/review/" + projectID + "/" + current.ID
				browser := newBrowser(t)
				if next := response(t, browser, "GET", listener.URL+webPath, "", "", nil, 303, nil); !strings.Contains(next, "return_to=") {
					t.Fatal("unauthenticated review did not redirect to login")
				}
				endpointURL, err := url.Parse(listener.URL)
				if err != nil {
					t.Fatal(err)
				}
				browser.Jar.SetCookies(endpointURL, []*http.Cookie{handler.cookie(webSessionCookie, webToken, time.Hour)})
				page, err := browser.Get(listener.URL + webPath)
				if err != nil {
					t.Fatal(err)
				}
				html, err := io.ReadAll(page.Body)
				page.Body.Close()
				if err != nil || page.StatusCode != 200 || !bytes.Contains(html, []byte("WAV 비교")) ||
					!strings.Contains(page.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
					t.Fatal("authorized review page did not render")
				}

				if previewDestination != "" {
					var createdComment reviewComment
					response(t, listener.Client(), "POST", currentURL+"/comments", reviewerToken, "",
						map[string]any{"commit_oid": current.HeadOID, "body": "변경 버전의 음원 참조를 확인했습니다.", "position_ticks": 480}, 201, &createdComment)
					previewURL := listener.URL + "/test-preview/" + webToken + "?" + url.Values{"target": {webPath}}.Encode()
					record := map[string]string{"entry": previewURL, "page": listener.URL + webPath, "baseline": currentURL}
					raw, _ := json.Marshal(record)
					if err := os.WriteFile(previewDestination, raw, 0600); err != nil {
						t.Fatal(err)
					}

					ticker := time.NewTicker(300 * time.Millisecond)
					defer ticker.Stop()
					expires := time.After(3 * time.Minute)
				preview:
					for {
						select {
						case <-expires:
							break preview
						case <-ticker.C:
							if _, err := os.Stat(previewDestination + ".done"); err == nil {
								break preview
							}
						}
					}
				}

				response(t, listener.Client(), "GET", currentURL+"/media/"+queued.ID+"/wav", outsiderToken, "", nil, 404, nil)

				document["trackOrder"] = []string{"review-midi"}
				document["tracks"] = map[string]any{"review-midi": map[string]any{"name": "Fixture MIDI", "kind": "midi", "gainDb": 0, "pan": 0,
					"muted": false, "solo": false, "pluginChain": []string{"review-plugin"}}}
				document["plugins"] = map[string]any{"review-plugin": map[string]any{"identifier": "VST3:Fixture:Unavailable:12345678", "format": "vst3",
					"stateHash": emptyBlobHash, "parameters": map[string]any{}, "bypassed": false}}
				document["routes"] = map[string]any{"review-route": map[string]any{"sourceTrackId": "review-midi", "destinationTrackId": nil, "kind": "output", "gainDb": 0, "preFader": false}}
				writeFile("project.json", encode())
				writeFile("plugin-states/"+emptyBlobHash+".bin", nil)
				commit("version with unavailable plugin")
				gitClient(t, git, source, editorToken, true, "push", "origin", "HEAD:refs/heads/missing-plugin")
				pluginReview := newReview("missing-plugin")
				pluginURL := endpoint + "/" + pluginReview.ID
				missing := queue(pluginURL, pluginReview.HeadOID)
				missingVersions := finish(pluginURL)
				if len(missingVersions) != 1 || missingVersions[0].State != "incomplete" || missingVersions[0].Reason != "missing_plugins" {
					t.Fatalf("unavailable plugin did not mark render incomplete: %+v", missingVersions)
				}
				response(t, listener.Client(), "GET", pluginURL+"/media/"+missing.ID+"/wav", reviewerToken, "", nil, 404, nil)

				t.Run("snapshot_restore", func(t *testing.T) {
					shared, err := AcquireMaintenance(t.Context(), pool, false)
					if err != nil {
						t.Fatal(err)
					}
					exclusive, err := AcquireMaintenance(t.Context(), pool, true)
					if err == nil {
						exclusive()
						shared()
						t.Fatal("maintenance overlapped the running service")
					}
					shared()
					release, err := AcquireMaintenance(t.Context(), pool, true)
					if err != nil {
						t.Fatal(err)
					}
					defer release()

					expiry := queue(currentURL, current.BaseOID)
					if expiry.State != "ready" {
						t.Fatal("ready render changed on repeat")
					}
					var pending reviewMedia
					response(t, listener.Client(), "POST", currentURL+"/media", editorToken, "",
						map[string]any{"commit_oid": current.BaseOID, "begin_seconds": 0, "end_seconds": 0.5}, 202, &pending)
					if _, err := pool.Exec(t.Context(), `UPDATE review_media_versions SET state='running',attempts=1,lease_id=gen_random_uuid(),
      lease_until=now()-interval '1 second' WHERE id=$1`, pending.ID); err != nil {
						t.Fatal(err)
					}

					snapshotFolder := filepath.Join(root, "backup")
					origin := snapshotState{pool: pool, git: repositories, blobs: blobs}
					if err := origin.snapshot(t.Context(), snapshotFolder); err != nil {
						t.Fatal(err)
					}
					archive, err := readSnapshot(snapshotFolder)
					if err != nil || len(archive.Objects) < 2 || len(archive.Repositories) != 1 {
						t.Fatalf("backup did not contain Git and media: %v", err)
					}

					restoredPool := integrationPool(t)
					restoredGit, err := NewGitRepositories(t.Context(), GitConfig{Root: filepath.Join(root, "restored-git"), Executable: git})
					if err != nil {
						t.Fatal(err)
					}
					restoredBlobs, _ := testObjectStore(t)
					restored := snapshotState{pool: restoredPool, git: restoredGit, blobs: restoredBlobs}
					if err := restored.restore(t.Context(), snapshotFolder); err != nil {
						t.Fatal(err)
					}
					if err := restored.restore(t.Context(), snapshotFolder); err == nil {
						t.Fatal("restore accepted a populated database")
					}

					bare, err := restoredGit.repository(t.Context(), projectID)
					if err != nil {
						t.Fatal(err)
					}
					gotRefs, err := snapshotRefs(t.Context(), restoredGit, bare)
					if err != nil || gotRefs != archive.Repositories[0].Refs {
						t.Fatal("Git refs differed after restore")
					}

					restoredServer := &Server{pool: restoredPool, git: restoredGit, blobs: restoredBlobs, renderer: handler.renderer, projectTool: tool, mux: http.NewServeMux()}
					restoredServer.receive, err = startReceiveGate(hook, 2, restoredServer.validateReceive)
					if err != nil {
						t.Fatal(err)
					}
					defer restoredServer.Close()
					restoredServer.routes()
					restarted := httptest.NewServer(restoredServer)
					defer restarted.Close()
					response(t, restarted.Client(), "GET", restarted.URL+"/v1/me", reviewerToken, "", nil, 401, nil)
					afterLogin, err := createSession(t.Context(), restoredPool, reviewer, "native")
					if err != nil {
						t.Fatal(err)
					}

					restoredURL := restarted.URL + "/v1/projects/" + projectID + "/reviews/" + current.ID
					var rebuilt review
					response(t, restarted.Client(), "GET", restoredURL, afterLogin, "", nil, 200, &rebuilt)
					if rebuilt.MergedOID != merged.MergedOID {
						t.Fatal("review merge was lost")
					}
					readback, err := http.NewRequestWithContext(t.Context(), "GET", restoredURL+"/media/"+queued.ID+"/wav", nil)
					if err != nil {
						t.Fatal(err)
					}
					readback.Header.Set("Authorization", "Bearer "+afterLogin)
					result, err := restarted.Client().Do(readback)
					if err != nil {
						t.Fatal(err)
					}
					waveform, err := io.ReadAll(result.Body)
					result.Body.Close()
					if err != nil || result.StatusCode != 200 || !bytes.Equal(waveform, actual) {
						t.Fatal("restored WAV differs")
					}
					response(t, restarted.Client(), "GET", restarted.URL+"/v1/operations", afterLogin, "", nil, 403, nil)
					if _, err := restoredPool.Exec(t.Context(), `UPDATE accounts SET operator=true WHERE id=$1`, owner); err != nil {
						t.Fatal(err)
					}
					operatorToken, err := createSession(t.Context(), restoredPool, owner, "native")
					if err != nil {
						t.Fatal(err)
					}
					var metrics map[string]any
					response(t, restarted.Client(), "GET", restarted.URL+"/v1/operations", operatorToken, "", nil, 200, &metrics)
					if metrics["lfs_objects"].(float64) < 1 || metrics["requests"] == nil {
						t.Fatal("restored operation metrics were missing")
					}

					worked, err := restoredServer.workReviewRender(t.Context())
					if err != nil || !worked {
						t.Fatalf("restored renderer did not recover job: %v", err)
					}
					var state, reason string
					if err := restoredPool.QueryRow(t.Context(), `SELECT state,coalesce(reason,'') FROM review_media_versions WHERE id=$1`, pending.ID).Scan(&state, &reason); err != nil || state != "ready" {
						t.Fatalf("restored render did not complete: %s %s %v", state, reason, err)
					}

					damaged := filepath.Join(snapshotFolder, archive.Tables[0].Path)
					if err := os.WriteFile(damaged, []byte("damaged"), 0600); err != nil {
						t.Fatal(err)
					}
					if _, err := readSnapshot(snapshotFolder); err == nil {
						t.Fatal("damaged backup passed its checksum")
					}
				})

			})
		}

		refs := gitClient(t, git, source, reviewerToken, true, "ls-remote", remote)
		if strings.Contains(refs, "refs/ayotbi/") {
			t.Fatal("private review refs were advertised")
		}
	})

}
