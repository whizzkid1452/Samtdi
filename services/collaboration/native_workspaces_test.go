package collaboration

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPublicWebSignupAndCodeOnlyTeamAdmission(t *testing.T) {
	pool := integrationPool(t)
	provider, setIdentity := testProvider(t)
	listener := httptest.NewUnstartedServer(nil)
	origin := "http://" + listener.Listener.Addr().String()
	handler, err := NewServer(t.Context(), pool, Config{Origin: origin, Issuer: provider.URL,
		ClientID: "test-client", ClientSecret: "test-secret", BootstrapEmail: "bootstrap@example.test",
		PublicSignup: true, AllowLoopbackHTTP: true})
	if err != nil {
		listener.Close()
		t.Fatal(err)
	}
	listener.Config.Handler = handler
	listener.Start()
	t.Cleanup(listener.Close)

	login := func(subject, email string) *http.Client {
		client := newBrowser(t)
		setIdentity(testIdentity{subject, email, true})
		callback := loginThroughProvider(t, client, origin+"/v1/auth/signup")
		response(t, client, "GET", callback, "", "", nil, 303, nil)
		return client
	}
	owner := login("owner", "creator@example.test")
	invitee := login("invitee", "invitee@example.test")
	outsider := login("outsider", "outsider@example.test")
	var spaces struct {
		Enabled    bool        `json:"enabled"`
		JoinByCode bool        `json:"join_by_code"`
		Workspaces []workspace `json:"workspaces"`
	}
	response(t, invitee, "GET", origin+"/v1/workspaces", "", "", nil, 200, &spaces)
	if !spaces.Enabled || !spaces.JoinByCode || len(spaces.Workspaces) != 1 || !spaces.Workspaces[0].Personal {
		t.Fatalf("new account did not receive a personal workspace: %+v", spaces)
	}
	response(t, invitee, "POST", origin+"/v1/projects", "", origin, map[string]string{"title": "Personal project", "workspace_id": spaces.Workspaces[0].ID}, 201, nil)

	team := "0296e9b8-60b4-4e51-85dc-d4d304563fb3"
	teamURL := origin + "/v1/workspaces/" + team
	response(t, owner, "POST", origin+"/v1/workspaces", "", origin, map[string]string{"id": team, "name": "Studio"}, 201, nil)
	response(t, owner, "POST", teamURL+"/members", "", origin, map[string]string{"email": "invitee@example.test"}, 403, nil)
	response(t, invitee, "POST", teamURL+"/invitations", "", origin, map[string]string{"email": "outsider@example.test"}, 404, nil)
	var invite workspaceInvitation
	response(t, owner, "POST", teamURL+"/invitations", "", origin, map[string]string{"email": "invitee@example.test"}, 201, &invite)
	if !tokenPattern.MatchString(invite.Code) {
		t.Fatal("team invite has no usable code")
	}
	var listed []workspaceInvitation
	response(t, owner, "GET", teamURL+"/invitations", "", "", nil, 200, &listed)
	if len(listed) != 1 || listed[0].Code != "" {
		t.Fatal("a previously issued code was exposed in the invite list")
	}
	join := origin + "/v1/workspaces/join"
	body := map[string]string{"code": invite.Code}
	response(t, newBrowser(t), "POST", join, "", origin, body, 401, nil)
	response(t, outsider, "POST", join, "", origin, body, 404, nil)
	response(t, invitee, "POST", join, "", "https://foreign.example", body, 403, nil)
	response(t, invitee, "POST", join, "", origin, body, 200, nil)
	response(t, invitee, "POST", join, "", origin, body, 404, nil)
	response(t, invitee, "POST", teamURL+"/invitations", "", origin, map[string]string{"email": "outsider@example.test"}, 403, nil)
	var created project
	response(t, invitee, "POST", origin+"/v1/projects", "", origin, map[string]string{"title": "Team project", "workspace_id": team}, 201, &created)
	projectURL := origin + "/v1/projects/" + created.ID
	response(t, outsider, "GET", projectURL+"/members", "", "", nil, 404, nil)
	response(t, invitee, "GET", projectURL+"/members", "", "", nil, 200, nil)
	var inviteeSession Session
	response(t, invitee, "GET", origin+"/v1/me", "", "", nil, 200, &inviteeSession)
	response(t, owner, "DELETE", teamURL+"/members/"+inviteeSession.AccountID, "", origin, nil, 204, nil)
	response(t, invitee, "GET", projectURL+"/members", "", "", nil, 404, nil)

	var revoked workspaceInvitation
	response(t, owner, "POST", teamURL+"/invitations", "", origin, map[string]string{"email": "outsider@example.test"}, 201, &revoked)
	response(t, owner, "DELETE", teamURL+"/invitations/"+revoked.ID, "", origin, nil, 204, nil)
	response(t, outsider, "POST", join, "", origin, map[string]string{"code": revoked.Code}, 404, nil)
}
