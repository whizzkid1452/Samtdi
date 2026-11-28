package collaboration

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"
)

const (
	loginCookie     = "ayotbi_login"
	loginCallback   = "/v1/auth/callback"
	nativeCallback  = "/ayotbi/oauth/callback"
	sessionDuration = 30 * 24 * time.Hour
)

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var verifierPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)

func randomToken() string {
	var secret [32]byte
	_, _ = rand.Read(secret[:])
	return base64.RawURLEncoding.EncodeToString(secret[:])
}

func tokenHash(token string) []byte {
	digest := sha256.Sum256([]byte(token))
	return digest[:]
}

func validNativeRedirect(raw string) bool {
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" ||
		endpoint.Path != nativeCallback || endpoint.User != nil || endpoint.RawPath != "" ||
		endpoint.RawQuery != "" || endpoint.ForceQuery || endpoint.Fragment != "" {
		return false
	}

	port, err := strconv.Atoi(endpoint.Port())
	return err == nil && port > 0 && port <= 65535 &&
		raw == "http://127.0.0.1:"+strconv.Itoa(port)+nativeCallback
}

type loginAttempt struct {
	Nonce      string
	Verifier   string
	InviteHash []byte
	Redirect   string
	State      string
	Challenge  string
	WebReturn  string
}

func (s *Server) webAuthOptions(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"public_signup": s.config.PublicSignup})
}

func (s *Server) beginLogin(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	signup := r.URL.Path == "/v1/auth/signup"
	if signup && !s.config.PublicSignup {
		problem(w, http.StatusNotFound, "resource_not_found")
		return
	}

	attempt := loginAttempt{Nonce: randomToken(), Verifier: oauth2.GenerateVerifier()}
	if signup || r.URL.Path == "/v1/auth/login" {
		attempt.WebReturn = query.Get("return_to")
		if attempt.WebReturn != "" && !safeWebReturn(attempt.WebReturn) {
			problem(w, http.StatusBadRequest, "invalid_return_path")
			return
		}
	}
	if r.URL.Path == "/v1/native/authorize" {
		attempt.Redirect = query.Get("redirect_uri")
		attempt.State = query.Get("state")
		attempt.Challenge = query.Get("code_challenge")
		if !validNativeRedirect(attempt.Redirect) || !tokenPattern.MatchString(attempt.State) ||
			!tokenPattern.MatchString(attempt.Challenge) || query.Get("code_challenge_method") != "S256" {
			problem(w, http.StatusBadRequest, "invalid_native_authorization")
			return
		}
	}

	if invite := query.Get("invite"); invite != "" {
		if !tokenPattern.MatchString(invite) {
			problem(w, http.StatusBadRequest, "invalid_invitation")
			return
		}
		if r.URL.Path == "/v1/auth/login" {
			session, err := s.authenticate(r, false)
			if err == nil && session.Kind == "web" {
				http.Redirect(w, r, "/invite/"+invite, http.StatusSeeOther)
				return
			}
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				internal(w, "authenticate_invitation_login", err)
				return
			}
		}
		attempt.InviteHash = tokenHash(invite)
	}

	browser := randomToken()
	if cookie, err := r.Cookie(s.cookieName(loginCookie)); err == nil && tokenPattern.MatchString(cookie.Value) {
		browser = cookie.Value
	}

	state := randomToken()
	_, err := s.pool.Exec(r.Context(), `INSERT INTO login_attempts
 (state_hash, browser_hash, nonce, verifier, invite_hash, native_redirect, native_state, native_challenge, web_return)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		tokenHash(state), tokenHash(browser), attempt.Nonce, attempt.Verifier,
		attempt.InviteHash, attempt.Redirect, attempt.State, attempt.Challenge, attempt.WebReturn)
	if err != nil {
		internal(w, "begin_login", err)
		return
	}

	http.SetCookie(w, s.cookie(loginCookie, browser, 10*time.Minute))
	options := []oauth2.AuthCodeOption{oidc.Nonce(attempt.Nonce), oauth2.S256ChallengeOption(attempt.Verifier)}
	if signup {
		options = append(options, oauth2.SetAuthURLParam("first_screen", "register"))
	}
	target := s.oauth.AuthCodeURL(state, options...)
	http.Redirect(w, r, target, http.StatusSeeOther)
}

func (s *Server) completeLogin(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	browser, err := r.Cookie(s.cookieName(loginCookie))
	if err != nil || !tokenPattern.MatchString(browser.Value) || !tokenPattern.MatchString(state) {
		problem(w, http.StatusBadRequest, "invalid_login_state")
		return
	}

	var attempt loginAttempt
	err = s.pool.QueryRow(r.Context(), `DELETE FROM login_attempts
 WHERE state_hash = $1 AND browser_hash = $2 AND expires_at > now()
 RETURNING nonce, verifier, invite_hash, native_redirect, native_state, native_challenge, web_return`,
		tokenHash(state), tokenHash(browser.Value)).
		Scan(&attempt.Nonce, &attempt.Verifier, &attempt.InviteHash, &attempt.Redirect, &attempt.State, &attempt.Challenge, &attempt.WebReturn)
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, http.StatusBadRequest, "invalid_login_state")
		return
	}
	if err != nil {
		internal(w, "consume_login", err)
		return
	}

	ctx := oidc.ClientContext(r.Context(), s.providerClient)
	code := r.URL.Query().Get("code")
	if code == "" || r.URL.Query().Has("error") {
		problem(w, http.StatusUnauthorized, "login_denied")
		return
	}

	identity, err := s.verifyIdentity(ctx, code, attempt)
	if err != nil {
		problem(w, http.StatusUnauthorized, "identity_not_verified")
		return
	}

	accountID, err := s.admitAccount(ctx, identity, attempt.InviteHash, s.config.PublicSignup && attempt.Redirect == "")
	if errors.Is(err, errInvitationRequired) {
		problem(w, http.StatusForbidden, "invitation_required")
		return
	}
	if errors.Is(err, errInvitationRejected) {
		problem(w, http.StatusForbidden, "invitation_rejected")
		return
	}
	if errors.Is(err, errIdentityEmailConflict) {
		problem(w, http.StatusConflict, "email_already_registered")
		return
	}
	if err != nil {
		writeWebError(w, "admit_account", err)
		return
	}

	if attempt.Redirect != "" {
		s.issueNativeCode(w, r, accountID, attempt)
		return
	}

	token, err := createSession(ctx, s.pool, accountID, "web")
	if err != nil {
		internal(w, "create_web_session", err)
		return
	}

	if previous, err := r.Cookie(s.cookieName(webSessionCookie)); err == nil {
		if _, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1 AND kind = 'web'`, tokenHash(previous.Value)); err != nil {
			internal(w, "replace_web_session", err)
			return
		}
	}

	http.SetCookie(w, s.cookie(webSessionCookie, token, sessionDuration))
	target := attempt.WebReturn
	if target == "" {
		target = "/"
	}
	http.Redirect(w, r, target, http.StatusSeeOther)
}

type identity struct {
	Issuer  string
	Subject string
	Email   string
	Name    string
}

func (s *Server) verifyIdentity(ctx context.Context, code string, attempt loginAttempt) (identity, error) {
	tokens, err := s.oauth.Exchange(ctx, code, oauth2.VerifierOption(attempt.Verifier))
	if err != nil {
		return identity{}, err
	}

	encoded, ok := tokens.Extra("id_token").(string)
	if !ok {
		return identity{}, errors.New("missing ID token")
	}

	idToken, err := s.verifier.Verify(ctx, encoded)
	if err != nil {
		return identity{}, err
	}
	if idToken.Nonce != attempt.Nonce || idToken.Subject == "" || len(idToken.Subject) > 255 {
		return identity{}, errors.New("invalid ID token claims")
	}

	var claims struct {
		Email           string `json:"email"`
		Name            string `json:"name"`
		Verified        bool   `json:"email_verified"`
		AuthorizedParty string `json:"azp"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return identity{}, err
	}
	if !claims.Verified || ((len(idToken.Audience) > 1 || claims.AuthorizedParty != "") &&
		claims.AuthorizedParty != s.config.ClientID) {
		return identity{}, errors.New("ID token email or audience is not verified")
	}

	email, err := verifiedEmail(claims.Email)
	if err != nil {
		return identity{}, err
	}

	// The provider's name only seeds the display name; people can change it afterwards.
	name, valid := displayName(claims.Name)
	if !valid {
		name = ""
	}
	return identity{Issuer: idToken.Issuer, Subject: idToken.Subject, Email: email, Name: name}, nil
}

func (s *Server) issueNativeCode(w http.ResponseWriter, r *http.Request, accountID string, attempt loginAttempt) {
	code := randomToken()
	_, err := s.pool.Exec(r.Context(), `INSERT INTO native_codes (code_hash, account_id, redirect, challenge)
 VALUES ($1, $2, $3, $4)`, tokenHash(code), accountID, attempt.Redirect, attempt.Challenge)
	if err != nil {
		internal(w, "issue_native_code", err)
		return
	}

	query := url.Values{"code": {code}, "state": {attempt.State}}
	http.Redirect(w, r, attempt.Redirect+"?"+query.Encode(), http.StatusSeeOther)
}

func (s *Server) exchangeNativeCode(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Code     string `json:"code"`
		Redirect string `json:"redirect_uri"`
		Verifier string `json:"code_verifier"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if !tokenPattern.MatchString(input.Code) || !validNativeRedirect(input.Redirect) || !verifierPattern.MatchString(input.Verifier) {
		problem(w, http.StatusBadRequest, "invalid_native_exchange")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		internal(w, "exchange_native_code", err)
		return
	}
	defer tx.Rollback(ctx)

	var accountID string
	err = tx.QueryRow(ctx, `DELETE FROM native_codes
 WHERE code_hash = $1 AND redirect = $2 AND challenge = $3 AND expires_at > now()
 RETURNING account_id::text`, tokenHash(input.Code), input.Redirect, oauth2.S256ChallengeFromVerifier(input.Verifier)).Scan(&accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, http.StatusUnauthorized, "invalid_or_expired_native_code")
		return
	}
	if err != nil {
		internal(w, "consume_native_code", err)
		return
	}

	token, err := createSession(ctx, tx, accountID, "native")
	if err != nil {
		internal(w, "create_native_session", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		internal(w, "exchange_native_code_commit", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": token, "token_type": "Bearer", "expires_in": int(sessionDuration.Seconds()),
	})
}

func (s *Server) cookie(name, value string, maxAge time.Duration) *http.Cookie {
	return &http.Cookie{
		Name: s.cookieName(name), Value: value, Path: "/", HttpOnly: true, Secure: s.secureCookies,
		SameSite: http.SameSiteLaxMode, MaxAge: int(maxAge.Seconds()),
	}
}

func (s *Server) cookieName(name string) string {
	if s.secureCookies {
		return "__Host-" + name
	}

	return name
}
