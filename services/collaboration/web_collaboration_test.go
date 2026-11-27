package collaboration

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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

	team.call("owner", "POST", "/v1/notifications/read-all", nil, 204, nil)
	team.call("editor", "GET", "/v1/notifications", nil, 200, &inbox)
	if len(inbox.Items) != 1 || inbox.Items[0].ReadAt != nil {
		t.Fatalf("another account marked editor notifications read: %+v", inbox.Items)
	}
	team.call("editor", "POST", "/v1/notifications/read-all", nil, 204, nil)
	team.call("editor", "GET", "/v1/notifications", nil, 200, &inbox)
	if len(inbox.Items) != 1 || inbox.Items[0].ReadAt == nil {
		t.Fatalf("mark all failed: %+v", inbox.Items)
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

func TestWebNoteCreatesTask(t *testing.T) {
	team := newWebTeam(t)
	notes := "./versions/" + team.version + "/notes"
	count := func() int {
		var rows []webNote
		team.call("owner", "GET", notes, nil, 200, &rows)
		return len(rows)
	}

	team.call("reviewer", "POST", notes, map[string]any{"start_ms": 500, "body": "검토자 의견", "task": map[string]string{}}, 403, nil)
	team.call("owner", "POST", notes, map[string]any{"start_ms": 500, "body": "잘못된 담당", "task": map[string]string{"assignee_id": team.ids["reviewer"]}}, 400, nil)
	team.call("owner", "POST", notes, map[string]any{"start_ms": 500, "body": "잘못된 날짜", "task": map[string]string{"due_on": "11월"}}, 400, nil)
	if count() != 0 {
		t.Fatal("rejected task requests left notes behind")
	}

	long := strings.Repeat("가", 170)
	var created map[string]string
	team.call("editor", "POST", notes, map[string]any{"start_ms": 2000, "end_ms": 4000, "body": "  " + long + "\n둘째 줄",
		"task": map[string]string{"assignee_id": team.ids["owner"], "due_on": "2026-11-21"}}, 201, &created)
	if created["id"] == "" || created["task_id"] == "" {
		t.Fatalf("created = %v", created)
	}
	var task webTask
	team.call("owner", "GET", "./tasks/"+created["task_id"], nil, 200, &task)
	if title := []rune(task.Title); len(title) != 160 || title[159] != '…' || task.Status != "todo" ||
		task.AssigneeID != team.ids["owner"] || task.DueOn != "2026-11-21" || task.Source == nil || task.Source.NoteID != created["id"] {
		t.Fatalf("task from note = %+v", task)
	}

	team.call("editor", "POST", notes, map[string]any{"start_ms": 3000, "body": "다음 할 일", "task": map[string]string{"title": "  직접 정한 제목 "}}, 201, &created)
	var second webTask
	team.call("owner", "GET", "./tasks/"+created["task_id"], nil, 200, &second)
	if second.Title != "직접 정한 제목" || second.AssigneeID != "" || second.Position <= task.Position {
		t.Fatalf("second task = %+v, first position %d", second, task.Position)
	}

	var note webNote
	team.call("reviewer", "GET", notes+"/"+created["id"], nil, 200, &note)
	if len(note.Tasks) != 1 || note.Tasks[0].ID != second.ID || note.Tasks[0].Status != "todo" {
		t.Fatalf("note tasks = %+v", note.Tasks)
	}

	var inbox struct {
		Items []webNotification `json:"items"`
	}
	team.call("owner", "GET", "/v1/notifications", nil, 200, &inbox)
	if len(inbox.Items) != 1 || inbox.Items[0].SubjectID != task.ID || inbox.Items[0].Action != "task.created" {
		t.Fatalf("only the assigned task notifies its assignee: %+v", inbox.Items)
	}
}

func TestWebTaskSchedule(t *testing.T) {
	team := newWebTeam(t)
	team.call("owner", "POST", "./tasks", map[string]any{"title": "거꾸로", "status": "todo", "start_on": "2026-11-20", "due_on": "2026-11-10"}, 400, nil)
	team.call("owner", "POST", "./tasks", map[string]any{"title": "잘못된 날짜", "status": "todo", "start_on": "11월 20일"}, 400, nil)

	span := team.task("owner", map[string]any{"title": "구간", "start_on": "2026-11-10", "due_on": "2026-11-14"})
	team.task("owner", map[string]any{"title": "마감만", "due_on": "2026-11-20"})
	team.task("owner", map[string]any{"title": "나중", "start_on": "2026-12-01", "due_on": "2026-12-03"})
	team.task("owner", map[string]any{"title": "날짜 없음"})
	titles := func(query string) string {
		var rows []webTask
		team.call("reviewer", "GET", "./tasks?"+query, nil, 200, &rows)
		names := make([]string, 0, len(rows))
		for _, row := range rows {
			names = append(names, row.Title)
		}
		return strings.Join(names, ",")
	}
	if got := titles("from=2026-11-12&to=2026-11-20"); got != "구간,마감만" {
		t.Fatalf("overlapping tasks = %q", got)
	}
	if got := titles("from=2026-11-15&to=2026-11-19"); got != "" {
		t.Fatalf("tasks outside the range were returned: %q", got)
	}
	if got := titles("scheduled=false"); got != "날짜 없음" {
		t.Fatalf("unscheduled tasks = %q", got)
	}
	team.call("reviewer", "GET", "./tasks?from=2026-11-20&to=2026-11-01", nil, 400, nil)
	team.call("reviewer", "GET", "./tasks?from=2026-01-01&to=2027-06-01", nil, 400, nil)
	team.call("reviewer", "GET", "./tasks?scheduled=maybe", nil, 400, nil)

	var task webTask
	team.call("owner", "GET", "./tasks/"+span, nil, 200, &task)
	if task.StartOn != "2026-11-10" || task.DueOn != "2026-11-14" {
		t.Fatalf("schedule = %s ~ %s", task.StartOn, task.DueOn)
	}
	team.call("editor", "PUT", "./tasks/"+span, map[string]any{"title": task.Title, "status": task.Status, "start_on": "2026-11-15", "due_on": "2026-11-14",
		"revision": task.Revision}, 400, nil)
	team.call("editor", "PUT", "./tasks/"+span, map[string]any{"title": task.Title, "status": task.Status, "start_on": "2026-11-12", "due_on": "",
		"revision": task.Revision}, 200, nil)
	team.call("owner", "GET", "./tasks/"+span, nil, 200, &task)
	if task.StartOn != "2026-11-12" || task.DueOn != "" {
		t.Fatalf("a start-only schedule was not saved: %s ~ %s", task.StartOn, task.DueOn)
	}

	today := time.Now().In(time.FixedZone("KST", 9*3600)).Format(time.DateOnly)
	var versions []webScheduleVersion
	team.call("reviewer", "GET", "./versions?from="+today+"&to="+today, nil, 200, &versions)
	if len(versions) != 1 || versions[0].ID != team.version || versions[0].ItemTitle != "메인 믹스" {
		t.Fatalf("versions uploaded today = %+v", versions)
	}
	team.call("reviewer", "GET", "./versions?from="+today, nil, 400, nil)
}

func TestWebDashboardOverview(t *testing.T) {
	team := newWebTeam(t)
	notes := "./versions/" + team.version + "/notes"
	var waiting, resolved, own map[string]string
	team.call("reviewer", "POST", notes, map[string]any{"start_ms": 1000, "end_ms": 2000, "body": "보컬이 커요"}, 201, &waiting)
	team.call("editor", "POST", notes, map[string]any{"start_ms": 3000, "body": "해결된 의견"}, 201, &resolved)
	team.call("owner", "POST", notes, map[string]any{"start_ms": 4000, "body": "내 메모"}, 201, &own)
	team.call("owner", "PATCH", notes+"/"+resolved["id"], map[string]any{"revision": 1, "resolved": true}, 204, nil)
	team.task("owner", map[string]any{"title": "보컬 낮추기", "assignee_id": team.ids["editor"], "start_on": "2026-11-10", "due_on": "2026-11-20",
		"note_ids": []string{waiting["id"]}})

	var overview struct {
		Feedback []struct {
			ID        string `json:"id"`
			ItemTitle string `json:"item_title"`
			AuthorID  string `json:"author_id"`
			EndMS     *int64 `json:"end_ms"`
		} `json:"feedback"`
		Versions []struct {
			ID         string `json:"id"`
			UploaderID string `json:"uploader_id"`
			OpenNotes  int    `json:"open_notes"`
		} `json:"versions"`
	}
	team.call("owner", "GET", "/v1/dashboard/overview", nil, 200, &overview)
	if len(overview.Feedback) != 1 || overview.Feedback[0].ID != waiting["id"] || overview.Feedback[0].ItemTitle != "메인 믹스" ||
		overview.Feedback[0].AuthorID != team.ids["reviewer"] || overview.Feedback[0].EndMS == nil {
		t.Fatalf("only others' open feedback on my upload is waiting: %+v", overview.Feedback)
	}
	if len(overview.Versions) != 1 || overview.Versions[0].ID != team.version || overview.Versions[0].UploaderID != team.ids["owner"] || overview.Versions[0].OpenNotes != 2 {
		t.Fatalf("recent versions = %+v", overview.Versions)
	}
	team.call("editor", "GET", "/v1/dashboard/overview", nil, 200, &overview)
	if len(overview.Feedback) != 0 || len(overview.Versions) != 1 {
		t.Fatalf("feedback belongs to the uploader only: %+v", overview)
	}

	var dashboard struct {
		Tasks []struct {
			Title     string         `json:"title"`
			StartOn   string         `json:"start_on"`
			NoteCount int            `json:"note_count"`
			Source    *webTaskSource `json:"source"`
			Assignee  *struct {
				Email string `json:"email"`
			} `json:"assignee"`
		} `json:"tasks"`
	}
	team.call("editor", "GET", "/v1/dashboard?filter=assigned", nil, 200, &dashboard)
	if len(dashboard.Tasks) != 1 || dashboard.Tasks[0].StartOn != "2026-11-10" || dashboard.Tasks[0].NoteCount != 1 ||
		dashboard.Tasks[0].Source == nil || dashboard.Tasks[0].Assignee == nil || dashboard.Tasks[0].Assignee.Email != "editor@example.test" {
		t.Fatalf("dashboard task = %+v", dashboard.Tasks)
	}
}
