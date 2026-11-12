package collaboration

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"
)

func integrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("AYOTBI_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set AYOTBI_TEST_DATABASE_URL to run PostgreSQL integration tests")
	}

	ctx := t.Context()
	setup, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	var suffix [8]byte
	_, _ = rand.Read(suffix[:])
	schema := "test_" + hex.EncodeToString(suffix[:])
	if _, err := setup.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		setup.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := setup.Exec(cleanup, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Error(err)
		}
		setup.Close()
	})

	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	for range 2 {
		if err := Migrate(ctx, pool); err != nil {
			t.Fatal(err)
		}
	}

	return pool
}

type testIdentity struct {
	subject  string
	email    string
	verified bool
}

type testGrant struct {
	nonce     string
	challenge string
	identity  testIdentity
}

func testProvider(t *testing.T) (*httptest.Server, func(testIdentity)) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256,
		Key: jose.JSONWebKey{Key: key, KeyID: "test"}}, nil)
	if err != nil {
		t.Fatal(err)
	}

	var issuer string
	var lock sync.Mutex
	grants := make(map[string]testGrant)
	current := testIdentity{}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{
			"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token",
			"jwks_uri": issuer + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "test", Algorithm: "RS256", Use: "sig"}}})
	})
	mux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if query.Get("code_challenge_method") != "S256" || query.Get("client_id") != "test-client" {
			problem(w, 400, "invalid_authorization")
			return
		}

		code := randomToken()
		lock.Lock()
		grants[code] = testGrant{nonce: query.Get("nonce"), challenge: query.Get("code_challenge"), identity: current}
		lock.Unlock()
		next := url.Values{"code": {code}, "state": {query.Get("state")}}
		http.Redirect(w, r, query.Get("redirect_uri")+"?"+next.Encode(), http.StatusSeeOther)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if r.ParseForm() != nil {
			problem(w, 400, "invalid_token")
			return
		}
		user, pass, ok := r.BasicAuth()
		if !ok || user != "test-client" || pass != "test-secret" {
			problem(w, 401, "invalid_client")
			return
		}

		code := r.Form.Get("code")
		lock.Lock()
		grant, found := grants[code]
		delete(grants, code)
		lock.Unlock()
		if !found || oauth2.S256ChallengeFromVerifier(r.Form.Get("code_verifier")) != grant.challenge {
			problem(w, 401, "invalid_grant")
			return
		}

		claims := jwt.Claims{Issuer: issuer, Subject: grant.identity.subject, Audience: jwt.Audience{"test-client"},
			IssuedAt: jwt.NewNumericDate(time.Now()), Expiry: jwt.NewNumericDate(time.Now().Add(time.Minute))}
		token, err := jwt.Signed(signer).Claims(claims).Claims(map[string]any{
			"nonce": grant.nonce, "email": grant.identity.email, "email_verified": grant.identity.verified,
		}).Serialize()
		if err != nil {
			problem(w, 500, "signing_failed")
			return
		}

		writeJSON(w, 200, map[string]string{"token_type": "Bearer", "access_token": randomToken(), "id_token": token})
	})

	provider := httptest.NewUnstartedServer(mux)
	issuer = "http://" + provider.Listener.Addr().String()
	provider.Start()
	t.Cleanup(provider.Close)

	return provider, func(identity testIdentity) {
		lock.Lock()
		defer lock.Unlock()
		current = identity
	}
}

func newBrowser(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}

	return &http.Client{Jar: jar, Timeout: 5 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

func response(t *testing.T, browser *http.Client, method, target, token, origin string, payload any, status int, output any) string {
	t.Helper()
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}

	r, err := http.NewRequestWithContext(t.Context(), method, target, body)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if payload != nil {
		r.Header.Set("Content-Type", "application/json")
	}

	result, err := browser.Do(r)
	if err != nil {
		t.Fatalf("%s request: %T", method, err)
	}
	defer result.Body.Close()
	if result.StatusCode != status {
		data, _ := io.ReadAll(io.LimitReader(result.Body, 512))
		t.Fatalf("%s %s: got %d, want %d, body %s", method, r.URL.Path, result.StatusCode, status, data)
	}
	if output != nil {
		if err := json.NewDecoder(result.Body).Decode(output); err != nil {
			t.Fatal(err)
		}
	}

	return result.Header.Get("Location")
}

func loginThroughProvider(t *testing.T, browser *http.Client, start string) string {
	t.Helper()
	authorize := response(t, browser, "GET", start, "", "", nil, 303, nil)
	return response(t, browser, "GET", authorize, "", "", nil, 303, nil)
}

func TestSharedIdentityAndNativeExchange(t *testing.T) {
	pool := integrationPool(t)
	provider, identity := testProvider(t)
	listener := httptest.NewUnstartedServer(nil)
	origin := "http://" + listener.Listener.Addr().String()
	handler, err := NewServer(t.Context(), pool, Config{Origin: origin, Issuer: provider.URL,
		ClientID: "test-client", ClientSecret: "test-secret", BootstrapEmail: "owner@example.test", AllowLoopbackHTTP: true})
	if err != nil {
		listener.Close()
		t.Fatal(err)
	}
	listener.Config.Handler = handler
	listener.Start()
	t.Cleanup(listener.Close)

	owner := newBrowser(t)
	guest := newBrowser(t)
	ownerIdentity := testIdentity{"owner-id", "owner@example.test", true}
	editorIdentity := testIdentity{"editor-id", "editor@example.test", true}
	identity(ownerIdentity)
	login := loginThroughProvider(t, owner, origin+"/v1/auth/login")
	response(t, guest, "GET", login, "", "", nil, 400, nil)
	response(t, owner, "GET", login, "", "", nil, 303, nil)
	response(t, owner, "GET", login, "", "", nil, 400, nil)

	response(t, owner, "GET", origin+"/v1/auth/login?return_to=https://unrelated.example", "", "", nil, 400, nil)
	reviewLogin := loginThroughProvider(t, owner, origin+"/v1/auth/login?return_to=%2Freview")
	if target := response(t, owner, "GET", reviewLogin, "", "", nil, 303, nil); target != "/review" {
		t.Fatal("web login did not preserve its safe review destination")
	}

	var ownerSession Session
	response(t, owner, "GET", origin+"/v1/me", "", "", nil, 200, &ownerSession)
	if ownerSession.Kind != "web" || ownerSession.Email != ownerIdentity.email {
		t.Fatal("unexpected web identity")
	}

	var created project
	response(t, owner, "POST", origin+"/v1/projects", "", "https://elsewhere.example", map[string]string{"title": "테스트"}, 403, nil)
	response(t, owner, "POST", origin+"/v1/projects", "", origin, map[string]string{"title": "테스트"}, 201, &created)
	if created.Role != Owner || created.ID == "" {
		t.Fatal("created project lacks an owner")
	}

	projectURL := origin + "/v1/projects/" + created.ID
	response(t, owner, "DELETE", projectURL+"/members/"+ownerSession.AccountID, "", origin, nil, 409, nil)
	newInvite := func(email, role string) map[string]any {
		t.Helper()
		var invitation map[string]any
		response(t, owner, "POST", projectURL+"/invitations", "", origin, map[string]string{"email": email, "role": role}, 201, &invitation)
		return invitation
	}

	identity(editorIdentity)
	login = loginThroughProvider(t, guest, origin+"/v1/auth/login")
	response(t, guest, "GET", login, "", "", nil, 403, nil)
	invitation := newInvite(editorIdentity.email, "editor")
	inviteURL := invitation["accept_url"].(string)
	identity(testIdentity{"unverified", editorIdentity.email, false})
	login = loginThroughProvider(t, guest, inviteURL)
	response(t, guest, "GET", login, "", "", nil, 401, nil)
	identity(testIdentity{"wrong", "someone@example.test", true})
	login = loginThroughProvider(t, guest, inviteURL)
	response(t, guest, "GET", login, "", "", nil, 403, nil)
	identity(editorIdentity)
	login = loginThroughProvider(t, guest, inviteURL)
	response(t, guest, "GET", login, "", "", nil, 303, nil)
	login = loginThroughProvider(t, guest, inviteURL)
	response(t, guest, "GET", login, "", "", nil, 403, nil)

	var webEditor Session
	response(t, guest, "GET", origin+"/v1/me", "", "", nil, 200, &webEditor)
	var members []member
	response(t, guest, "GET", projectURL+"/members", "", "", nil, 200, &members)
	if len(members) != 2 {
		t.Fatal("project membership was not linked")
	}
	response(t, guest, "POST", projectURL+"/invitations", "", origin, map[string]string{"email": "other@example.test", "role": "owner"}, 403, nil)

	revoked := newInvite("revoke@example.test", "reviewer")
	response(t, owner, "DELETE", projectURL+"/invitations/"+revoked["id"].(string), "", origin, nil, 204, nil)
	identity(testIdentity{"revoked", "revoke@example.test", true})
	login = loginThroughProvider(t, guest, revoked["accept_url"].(string))
	response(t, guest, "GET", login, "", "", nil, 403, nil)

	identity(editorIdentity)
	redirect := "http://127.0.0.1:53091" + nativeCallback
	verifier, state := randomToken(), randomToken()
	query := url.Values{"redirect_uri": {redirect}, "state": {state},
		"code_challenge": {oauth2.S256ChallengeFromVerifier(verifier)}, "code_challenge_method": {"S256"}}
	native := newBrowser(t)
	query.Set("redirect_uri", "https://unrelated.example/callback")
	response(t, native, "GET", origin+"/v1/native/authorize?"+query.Encode(), "", "", nil, 400, nil)
	query.Set("redirect_uri", redirect)
	login = loginThroughProvider(t, native, origin+"/v1/native/authorize?"+query.Encode())
	target := response(t, native, "GET", login, "", "", nil, 303, nil)
	returned, err := url.Parse(target)
	if err != nil || !strings.HasPrefix(target, redirect+"?") || returned.Query().Get("state") != state {
		t.Fatal("native redirect binding was lost")
	}

	exchange := map[string]string{"code": returned.Query().Get("code"), "redirect_uri": redirect, "code_verifier": randomToken()}
	response(t, native, "POST", origin+"/v1/native/token", "", "", exchange, 401, nil)
	exchange["code_verifier"] = verifier
	var token map[string]any
	response(t, native, "POST", origin+"/v1/native/token", "", "", exchange, 200, &token)
	response(t, native, "POST", origin+"/v1/native/token", "", "", exchange, 401, nil)

	access := token["access_token"].(string)
	var nativeEditor Session
	response(t, native, "GET", origin+"/v1/me", access, "", nil, 200, &nativeEditor)
	if nativeEditor.AccountID != webEditor.AccountID || nativeEditor.Kind != "native" {
		t.Fatal("native login did not reuse the web account")
	}

	var projects []project
	response(t, native, "GET", origin+"/v1/projects", access, "", nil, 200, &projects)
	if len(projects) != 1 || projects[0].ID != created.ID || projects[0].Role != Editor {
		t.Fatal("native account has incorrect project access")
	}
	response(t, owner, "PATCH", projectURL+"/members/"+webEditor.AccountID, "", origin, map[string]string{"role": "reviewer"}, 204, nil)
	response(t, native, "GET", origin+"/v1/projects", access, "", nil, 200, &projects)
	if projects[0].Role != Reviewer {
		t.Fatal("active native session did not observe new role")
	}
	response(t, owner, "DELETE", projectURL+"/members/"+webEditor.AccountID, "", origin, nil, 204, nil)
	response(t, native, "GET", projectURL+"/members", access, "", nil, 404, nil)
	response(t, native, "POST", origin+"/v1/auth/logout", access, "", nil, 204, nil)
	response(t, native, "GET", origin+"/v1/me", access, "", nil, 401, nil)
	response(t, owner, "POST", origin+"/v1/auth/logout", "", origin, nil, 204, nil)
	response(t, owner, "GET", origin+"/v1/me", "", "", nil, 401, nil)
}

func TestHeadlessProjectTool(t *testing.T) {
	executable := os.Getenv("AYOTBI_TEST_PROJECT_TOOL")
	document := os.Getenv("AYOTBI_TEST_PROJECT_DOCUMENT")
	if executable == "" || document == "" {
		t.Skip("set AYOTBI_TEST_PROJECT_TOOL and AYOTBI_TEST_PROJECT_DOCUMENT to test the C++ executable")
	}

	tool, err := NewProjectTool(executable)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(document)
	if err != nil {
		t.Fatal(err)
	}

	valid, err := tool.Validate(t.Context(), raw)
	if err != nil || !valid.OK || valid.ProtocolVersion != 1 {
		t.Fatalf("validate valid: %v", err)
	}
	invalid, err := tool.Validate(t.Context(), []byte(`{"invalid":true}`))
	if err != nil || invalid.OK {
		t.Fatalf("validate invalid: %v", err)
	}
	diff, err := tool.MusicDiff(t.Context(), raw, raw)
	if err != nil || !diff.OK {
		t.Fatalf("music diff: %v", err)
	}
	merge, err := tool.Merge(t.Context(), raw, raw, raw, nil)
	if err != nil || !merge.OK {
		t.Fatalf("merge: %v", err)
	}
}
