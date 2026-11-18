package collaboration

import "testing"

func TestSafeWebReturn(t *testing.T) {
	id := "65056998-9518-466a-b68e-cea4720d638b"
	for _, path := range []string{
		"/projects", "/work?filter=review", "/projects/" + id + "/tasks?view=board",
		"/projects?workspace=" + id, "/projects?workspace=shared",
		"/?project=" + id + "#task-board", "/review/" + id,
		"/projects/" + id + "/media/" + id + "/versions/" + id + "?note=" + id + "&at=120",
	} {
		if !safeWebReturn(path) {
			t.Errorf("valid return path rejected: %s", path)
		}
	}
	for _, path := range []string{
		"https://example.test/projects", "/projects/unknown/media", "/work?filter=unknown",
		"/projects?extra=1", "/work?filter=review&filter=late", "/v1/auth/login",
		"/projects?workspace=https://example.test", "/projects?workspace=" + id + "&workspace=shared",
	} {
		if safeWebReturn(path) {
			t.Errorf("invalid return path accepted: %s", path)
		}
	}
}
