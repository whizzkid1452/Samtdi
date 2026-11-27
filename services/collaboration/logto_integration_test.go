package collaboration

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkspaceRevocationCoversProjectAndAggregateEndpoints(t *testing.T) {
	pool := integrationPool(t)
	account, token := seedNative(t, pool, "reviewer")
	owner, _ := seedNative(t, pool, "owner")
	projectA := seedProject(t, pool, map[string]Role{owner: Owner, account: Reviewer})
	projectB := seedProject(t, pool, map[string]Role{owner: Owner, account: Reviewer})
	var revoked, unavailable, suspended atomic.Bool
	identityAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if unavailable.Load() {
			w.WriteHeader(503)
			return
		}
		if r.URL.Path == "/api/users/reviewer" {
			writeJSON(w, 200, logtoUser{ID: "reviewer", Suspended: suspended.Load()})
			return
		}
		if r.URL.Path != "/api/users/reviewer/organizations" {
			t.Errorf("unexpected identity request %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		organizations := []logtoOrganization{}
		if !revoked.Load() {
			organizations = append(organizations, logtoOrganization{ID: "organization-a", Name: "Team A"})
		}
		writeJSON(w, 200, organizations)
	}))
	t.Cleanup(identityAPI.Close)
	for _, entry := range []struct{ project, organization string }{{projectA, "organization-a"}, {projectB, "organization-b"}} {
		_, err := pool.Exec(t.Context(), `WITH space AS (INSERT INTO workspaces(id,requested_name,organization_id,created_by,active)
 VALUES(gen_random_uuid(),'Team',$1,$2,true) RETURNING id) UPDATE projects SET workspace_id=(SELECT id FROM space) WHERE id=$3`, entry.organization, owner, entry.project)
		if err != nil {
			t.Fatal(err)
		}
		var task string
		if err := pool.QueryRow(t.Context(), `INSERT INTO web_tasks(project_id,title,status,position) VALUES($1,'Private task','review',0) RETURNING id::text`, entry.project).Scan(&task); err != nil {
			t.Fatal(err)
		}
		var activity int64
		if err := pool.QueryRow(t.Context(), `INSERT INTO web_activity(project_id,actor_id,action,subject_id) VALUES($1,$2,'task.updated',$3) RETURNING id`, entry.project, owner, task).Scan(&activity); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(t.Context(), `INSERT INTO web_notifications(recipient_id,activity_id) VALUES($1,$2)`, account, activity); err != nil {
			t.Fatal(err)
		}
	}
	blobs, _ := testObjectStore(t)
	audio := []byte("RIFF-test-audio-bytes")
	digest := sha256.Sum256(audio)
	hash := hex.EncodeToString(digest[:])
	key := "review-media/" + hash
	if err := blobs.Put(t.Context(), key, BlobMetadata{Size: int64(len(audio)), SHA256: hash}, bytes.NewReader(audio)); err != nil {
		t.Fatal(err)
	}
	var version string
	if err := pool.QueryRow(t.Context(), `WITH item AS (INSERT INTO web_media_items(project_id,title) VALUES($1,'Private audio') RETURNING id),
 upload AS (INSERT INTO web_uploads(project_id,item_id,actor_id,filename,bytes,kind) SELECT $1,id,$2,'demo.wav',$3,'wav' FROM item RETURNING id,item_id)
 INSERT INTO web_media_versions(id,project_id,item_id,filename,description,state,playback_key,playback_bytes,playback_hash)
 SELECT id,$1,item_id,'demo.wav','','ready',$4,$3,$5 FROM upload RETURNING id::text`, projectA, owner, len(audio), key, hash).Scan(&version); err != nil {
		t.Fatal(err)
	}
	handler := &Server{pool: pool, mux: http.NewServeMux(), logto: &logtoClient{endpoint: identityAPI.URL, issuer: "test", client: identityAPI.Client()}}
	handler.blobs = blobs
	handler.routes()
	service := httptest.NewServer(handler)
	t.Cleanup(service.Close)
	browser := newBrowser(t)
	response(t, browser, "GET", service.URL+"/v1/projects/"+projectA+"/tasks", token, "", nil, 200, nil)
	response(t, browser, "GET", service.URL+"/v1/projects/"+projectB+"/tasks", token, "", nil, 404, nil)
	playback := service.URL + "/v1/projects/" + projectA + "/versions/" + version + "/files/playback"
	request, err := http.NewRequest("GET", playback, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Range", "bytes=0-3")
	played, err := browser.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(played.Body)
	played.Body.Close()
	if err != nil || played.StatusCode != 206 || string(data) != "RIFF" {
		t.Fatalf("authorized Range failed: %d %v", played.StatusCode, err)
	}
	var projects []project
	response(t, browser, "GET", service.URL+"/v1/projects", token, "", nil, 200, &projects)
	if len(projects) != 1 || projects[0].ID != projectA {
		t.Fatal("organization boundary was not applied to project list")
	}
	for _, denied := range []bool{false, true} {
		revoked.Store(denied)
		var dashboard struct {
			Review int   `json:"review_count"`
			Tasks  []any `json:"tasks"`
		}
		response(t, browser, "GET", service.URL+"/v1/dashboard?filter=review", token, "", nil, 200, &dashboard)
		var overview struct {
			Versions []any `json:"versions"`
		}
		response(t, browser, "GET", service.URL+"/v1/dashboard/overview", token, "", nil, 200, &overview)
		var notifications struct {
			Unread int   `json:"unread"`
			Items  []any `json:"items"`
		}
		response(t, browser, "GET", service.URL+"/v1/notifications", token, "", nil, 200, &notifications)
		want := 1
		if denied {
			want = 0
		}
		if dashboard.Review != want || len(dashboard.Tasks) != want || len(overview.Versions) != want ||
			notifications.Unread != want || len(notifications.Items) != want {
			t.Fatal("aggregate endpoint leaked an inaccessible workspace")
		}
	}
	response(t, browser, "GET", service.URL+"/v1/projects/"+projectA+"/tasks", token, "", nil, 404, nil)
	response(t, browser, "GET", playback, token, "", nil, 404, nil)
	response(t, browser, "GET", service.URL+"/v1/projects/"+projectA+"/export/json", token, "", nil, 404, nil)
	suspended.Store(true)
	response(t, browser, "GET", service.URL+"/v1/projects", token, "", nil, 403, nil)
	suspended.Store(false)
	unavailable.Store(true)
	response(t, browser, "GET", service.URL+"/v1/projects", token, "", nil, 503, nil)
	response(t, browser, "POST", service.URL+"/v1/auth/logout", token, "", nil, 204, nil)
	response(t, browser, "GET", service.URL+"/v1/me", token, "", nil, 401, nil)
}

func TestOperatorIdentityLinkPreservesAccountAndRejectsEmailOnlyMerge(t *testing.T) {
	pool := integrationPool(t)
	account, _ := seedNative(t, pool, "existing")
	identityAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oidc/token":
			writeJSON(w, 200, map[string]any{"access_token": "management-test-token", "token_type": "Bearer", "expires_in": 3600})
		case "/api/users/new-subject":
			writeJSON(w, 200, logtoUser{ID: "new-subject", Email: "existing@example.test"})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(identityAPI.Close)
	settings := Config{Issuer: identityAPI.URL + "/oidc", AllowLoopbackHTTP: true, Logto: LogtoConfig{
		Endpoint: identityAPI.URL, ClientID: "machine", ClientSecret: "test-secret", Resource: "https://default.logto.app/api"}}
	handler := &Server{pool: pool}
	identity := identity{Issuer: settings.Issuer, Subject: "new-subject", Email: "existing@example.test"}
	if _, err := handler.admitAccount(t.Context(), identity, nil); !errors.Is(err, errInvitationRequired) {
		t.Fatalf("email-only login must not link accounts: %v", err)
	}
	if err := LinkLogtoIdentity(t.Context(), pool, settings, account, "new-subject"); err != nil {
		t.Fatal(err)
	}
	linked, err := handler.admitAccount(t.Context(), identity, nil)
	if err != nil || linked != account {
		t.Fatalf("existing account lost after link: %s %v", linked, err)
	}
	other, _ := seedNative(t, pool, "other")
	if err := LinkLogtoIdentity(t.Context(), pool, settings, other, "new-subject"); err == nil {
		t.Fatal("identity reassignment must be rejected")
	}
}

func TestIdentityWorkspaceSnapshotsAndLegacyFormats(t *testing.T) {
	for _, version := range []int{1, 2, 3} {
		t.Run(string(rune('0'+version)), func(t *testing.T) {
			pool := integrationPool(t)
			account, _ := seedNative(t, pool, "snapshot-owner")
			project := seedProject(t, pool, map[string]Role{account: Owner})
			if version == 3 {
				_, err := pool.Exec(t.Context(), `WITH linked AS (INSERT INTO account_identities VALUES('new-issuer','new-subject',$1) RETURNING account_id)
 INSERT INTO workspaces(id,requested_name,organization_id,created_by,active) SELECT '55aabddc-fc4a-43f2-a29f-e2c4534222ff','Team','org-a',account_id,true FROM linked`, account)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := pool.Exec(t.Context(), `UPDATE projects SET workspace_id='55aabddc-fc4a-43f2-a29f-e2c4534222ff' WHERE id=$1`, project); err != nil {
					t.Fatal(err)
				}
			}
			blobs, _ := testObjectStore(t)
			root := filepath.Join(t.TempDir(), "snapshot")
			if version == 3 {
				if err := (snapshotState{pool: pool, blobs: blobs}).snapshot(t.Context(), root); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Mkdir(root, 0700); err != nil {
					t.Fatal(err)
				}
				tx, err := pool.Begin(t.Context())
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(t.Context())
				schema, err := snapshotSchema(t.Context(), tx)
				if err != nil {
					t.Fatal(err)
				}
				limit := 14
				if version == 1 {
					limit = 6
				}
				manifest := snapshotManifest{Version: version, CreatedAt: time.Now().UTC(), Schema: schema[:limit]}
				for _, table := range tablesForSnapshot(version) {
					columns := ""
					if table == "projects" {
						columns = " (id,title,created_at,song_id,archived_at)"
						if version == 1 {
							columns = " (id,title,created_at,song_id)"
						}
					}
					file, err := writeSnapshotFile(root, filepath.Join("db", table+".copy"), func(output io.Writer) error {
						_, err := tx.Conn().PgConn().CopyTo(t.Context(), output, "COPY "+table+columns+" TO STDOUT (FORMAT binary)")
						return err
					})
					if err != nil {
						t.Fatal(err)
					}
					manifest.Tables = append(manifest.Tables, file)
				}
				if err := tx.Commit(t.Context()); err != nil {
					t.Fatal(err)
				}
				data, err := json.Marshal(manifest)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "manifest.json"), data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			restored := integrationPool(t)
			if err := (snapshotState{pool: restored, blobs: blobs}).restore(t.Context(), root); err != nil {
				t.Fatal(err)
			}
			var id string
			if err := restored.QueryRow(t.Context(), "SELECT id::text FROM projects").Scan(&id); err != nil || id != project {
				t.Fatalf("project did not survive restore: %v", err)
			}
			if version == 3 {
				var count int
				if err := restored.QueryRow(t.Context(), "SELECT count(*) FROM account_identities WHERE account_id=$1", account).Scan(&count); err != nil || count != 1 {
					t.Fatalf("identity did not survive restore: %v", err)
				}
				if err := restored.QueryRow(t.Context(), "SELECT count(*) FROM workspaces WHERE active").Scan(&count); err != nil || count != 1 {
					t.Fatalf("workspace did not survive restore: %v", err)
				}
			}
		})
	}
}
