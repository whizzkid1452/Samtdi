package collaboration

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// webTeam is a project with an owner, an editor and a reviewer who call the web API with native bearer tokens.
type webTeam struct {
	t       *testing.T
	client  *http.Client
	url     string
	project string
	version string
	ids     map[string]string
	tokens  map[string]string
}

func newWebTeam(t *testing.T) *webTeam {
	t.Helper()
	pool := integrationPool(t)
	provider, _ := testProvider(t)
	listener := httptest.NewUnstartedServer(nil)
	origin := "http://" + listener.Listener.Addr().String()
	handler, err := NewServer(t.Context(), pool, Config{Origin: origin, Issuer: provider.URL,
		ClientID: "test-client", ClientSecret: "test-secret", AllowLoopbackHTTP: true})
	if err != nil {
		listener.Close()
		t.Fatal(err)
	}
	listener.Config.Handler = handler
	listener.Start()
	t.Cleanup(listener.Close)

	team := &webTeam{t: t, client: newBrowser(t), url: origin, ids: map[string]string{}, tokens: map[string]string{}}
	roles := map[string]Role{}
	for name, role := range map[string]Role{"owner": Owner, "editor": Editor, "reviewer": Reviewer} {
		id, token := seedNative(t, pool, name)
		team.ids[name], team.tokens[name], roles[id] = id, token, role
	}
	team.project = seedProject(t, pool, roles)
	err = pool.QueryRow(t.Context(), `WITH item AS (
 INSERT INTO web_media_items(project_id,title) VALUES ($1,'메인 믹스') RETURNING id
 ), upload AS (
 INSERT INTO web_uploads(project_id,item_id,actor_id,filename,bytes,kind)
 SELECT $1,id,$2,'mix.wav',100,'wav' FROM item RETURNING id,item_id
 )
 INSERT INTO web_media_versions(id,project_id,item_id,filename,description,state,duration_ms)
 SELECT id,$1,item_id,'mix.wav','','ready',60000 FROM upload RETURNING id::text`, team.project, team.ids["owner"]).Scan(&team.version)
	if err != nil {
		t.Fatal(err)
	}
	return team
}

func (team *webTeam) call(who, method, path string, payload any, status int, output any) {
	team.t.Helper()
	if strings.HasPrefix(path, "./") {
		path = "/v1/projects/" + team.project + path[1:]
	}
	response(team.t, team.client, method, team.url+path, team.tokens[who], "", payload, status, output)
}

func TestWebDisplayNames(t *testing.T) {
	team := newWebTeam(t)

	var session Session
	team.call("editor", "PATCH", "/v1/me", map[string]string{"name": "  이지은  "}, 200, &session)
	if session.Name != "이지은" {
		t.Fatalf("name was not trimmed and saved: %q", session.Name)
	}
	team.call("editor", "PATCH", "/v1/me", map[string]string{"name": strings.Repeat("가", 41)}, 400, nil)
	team.call("editor", "PATCH", "/v1/me", map[string]string{"name": "줄\n바꿈"}, 400, nil)
	team.call("editor", "PATCH", "/v1/me", map[string]any{}, 400, nil)
	team.call("editor", "GET", "/v1/me", nil, 200, &session)
	if session.Name != "이지은" {
		t.Fatalf("rejected names changed the saved name: %q", session.Name)
	}

	var members []member
	team.call("reviewer", "GET", "./members", nil, 200, &members)
	names := map[string]string{}
	for _, entry := range members {
		names[entry.AccountID] = entry.Name
	}
	if names[team.ids["editor"]] != "이지은" || names[team.ids["owner"]] != "" {
		t.Fatalf("members expose unexpected names: %v", names)
	}

	var created map[string]string
	team.call("editor", "POST", "./versions/"+team.version+"/notes", map[string]any{"start_ms": 1000, "body": "보컬이 커요"}, 201, &created)
	team.call("owner", "POST", "./versions/"+team.version+"/notes/"+created["id"]+"/replies", map[string]string{"body": "확인했어요"}, 201, nil)
	var note webNote
	team.call("owner", "GET", "./versions/"+team.version+"/notes/"+created["id"], nil, 200, &note)
	if note.Name != "이지은" || len(note.Replies) != 1 || note.Replies[0].Name != "" || note.Replies[0].Email != "owner@example.test" {
		t.Fatalf("note authors lack names: %+v", note)
	}

	var inbox struct {
		Items []webNotification `json:"items"`
	}
	team.call("editor", "GET", "/v1/notifications", nil, 200, &inbox)
	if len(inbox.Items) != 1 || inbox.Items[0].ActorEmail != "owner@example.test" || inbox.Items[0].Title != "확인했어요" {
		t.Fatalf("reply notification lacks its actor and text: %+v", inbox.Items)
	}

	team.call("editor", "PATCH", "/v1/me", map[string]string{"name": ""}, 200, &session)
	if session.Name != "" {
		t.Fatalf("an empty name must clear the display name: %q", session.Name)
	}
}

func (team *webTeam) task(who string, body map[string]any) string {
	team.t.Helper()
	payload := map[string]any{"description": "", "status": "todo", "assignee_id": "", "due_on": "", "result_version_id": "",
		"review_text": "", "archived": false, "revision": 0, "note_ids": []string{}, "confirm_notes": []any{}}
	for key, value := range body {
		payload[key] = value
	}
	var created map[string]string
	team.call(who, "POST", "./tasks", payload, 201, &created)
	return created["id"]
}

func TestWebTaskSourceAndSummary(t *testing.T) {
	team := newWebTeam(t)
	var note map[string]string
	team.call("reviewer", "POST", "./versions/"+team.version+"/notes", map[string]any{"start_ms": 1000, "end_ms": 3000, "body": "후렴 보컬"}, 201, &note)
	late := team.task("owner", map[string]any{"title": "보컬 낮추기", "assignee_id": team.ids["editor"], "due_on": "2020-01-01", "note_ids": []string{note["id"]}})
	team.task("owner", map[string]any{"title": "엔딩 정리"})
	team.task("owner", map[string]any{"title": "끝난 일", "status": "done", "assignee_id": team.ids["owner"]})

	var task webTask
	team.call("reviewer", "GET", "./tasks/"+late, nil, 200, &task)
	source := task.Source
	if source == nil || source.NoteID != note["id"] || source.ItemTitle != "메인 믹스" || source.Filename != "mix.wav" ||
		source.VersionID != team.version || source.StartMS != 1000 || source.EndMS == nil || *source.EndMS != 3000 {
		t.Fatalf("task source = %+v", source)
	}
	if task.CreatedAt.IsZero() || len(task.Notes) != 1 || task.Notes[0].EndMS == nil {
		t.Fatalf("task lacks its creation time or note range: %+v", task)
	}

	var summary struct {
		Open      int64             `json:"open"`
		Late      int64             `json:"late"`
		Assignees []webAssigneeLoad `json:"assignees"`
	}
	team.call("reviewer", "GET", "./task-summary?archived=false", nil, 200, &summary)
	loads := map[string]webAssigneeLoad{}
	for _, load := range summary.Assignees {
		loads[load.AssigneeID] = load
	}
	if summary.Open != 2 || summary.Late != 1 || loads[team.ids["editor"]].Late != 1 || loads[""].Open != 1 || loads[team.ids["owner"]].Open != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	team.call("reviewer", "GET", "./task-summary?assignee="+team.ids["editor"], nil, 200, &summary)
	if summary.Open != 1 || len(summary.Assignees) != 1 {
		t.Fatalf("summary ignores task filters: %+v", summary)
	}
	team.call("reviewer", "GET", "./task-summary?due=bad", nil, 400, nil)

	var current webNote
	team.call("reviewer", "GET", "./versions/"+team.version+"/notes/"+note["id"], nil, 200, &current)
	team.call("reviewer", "PATCH", "./versions/"+team.version+"/notes/"+note["id"], map[string]any{"revision": current.Revision, "deleted": true}, 204, nil)
	team.call("owner", "GET", "./tasks/"+late, nil, 200, &task)
	if task.Source != nil {
		t.Fatalf("a deleted note must not stay the task source: %+v", task.Source)
	}
}
