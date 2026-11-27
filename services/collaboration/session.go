package collaboration

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const webSessionCookie = "ayotbi_session"

type Session struct {
	AccountID     string `json:"account_id"`
	Email         string `json:"email"`
	Name          string `json:"name"`
	Kind          string `json:"kind"`
	tokenHash     []byte
	subject       string
	organizations map[string]logtoOrganization
}

type sessionWriter interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func createSession(ctx context.Context, db sessionWriter, accountID string, kind string) (string, error) {
	token := randomToken()
	_, err := db.Exec(ctx, `INSERT INTO sessions (token_hash, account_id, kind, expires_at)
 VALUES ($1, $2, $3, now() + make_interval(secs => $4))`, tokenHash(token), accountID, kind, sessionDuration.Seconds())
	return token, err
}

func (s *Server) authenticate(r *http.Request, allowGitBasic bool) (Session, error) {
	var token string
	kind := "native"
	authorization := r.Header.Get("Authorization")
	if authorization == "" {
		cookie, err := r.Cookie(s.cookieName(webSessionCookie))
		if err != nil {
			return Session{}, pgx.ErrNoRows
		}
		token = cookie.Value
		kind = "web"
	} else if scheme, value, _ := strings.Cut(authorization, " "); strings.EqualFold(scheme, "Bearer") {
		token = value
	} else if user, password, ok := r.BasicAuth(); allowGitBasic && ok && user == "ayotbi" {
		token = password
	}

	if !tokenPattern.MatchString(token) {
		return Session{}, pgx.ErrNoRows
	}

	session := Session{Kind: kind, tokenHash: tokenHash(token)}
	err := s.pool.QueryRow(r.Context(), `SELECT a.id::text, a.email, COALESCE(a.display_name, '') FROM sessions s
 JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1 AND s.kind = $2 AND s.expires_at > now()`,
		session.tokenHash, kind).Scan(&session.AccountID, &session.Email, &session.Name)
	return session, err
}

type sessionHandler func(http.ResponseWriter, *http.Request, Session)

func (s *Server) withSession(handler sessionHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		session, err := s.authenticate(r, false)
		if errors.Is(err, pgx.ErrNoRows) {
			problem(w, http.StatusUnauthorized, "authentication_required")
			return
		}
		if err != nil {
			internal(w, "authenticate", err)
			return
		}

		if session.Kind == "web" && r.Method != http.MethodGet && r.Method != http.MethodHead &&
			r.Header.Get("Origin") != s.origin {
			problem(w, http.StatusForbidden, "invalid_origin")
			return
		}
		if r.URL.Path != "/v1/auth/logout" {
			if err := s.loadOrganizations(r.Context(), &session); err != nil {
				writeWebError(w, "load_organizations", err)
				return
			}
			if err := s.authorizeWorkspaceProject(r.Context(), r.PathValue("project"), session); err != nil {
				writeWebError(w, "authorize_workspace", err)
				return
			}
		}

		handler(w, r, session)
	}
}

func (s *Server) me(w http.ResponseWriter, _ *http.Request, session Session) {
	writeJSON(w, http.StatusOK, session)
}

func (s *Server) changeMe(w http.ResponseWriter, r *http.Request, session Session) {
	var input struct {
		Name *string `json:"name"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if input.Name == nil {
		problem(w, http.StatusBadRequest, "invalid_name")
		return
	}
	name, valid := displayName(*input.Name)
	if !valid {
		problem(w, http.StatusBadRequest, "invalid_name")
		return
	}
	if _, err := s.pool.Exec(r.Context(), `UPDATE accounts SET display_name=NULLIF($2,'') WHERE id=$1`, session.AccountID, name); err != nil {
		internal(w, "change_name", err)
		return
	}
	session.Name = name
	writeJSON(w, http.StatusOK, session)
}

// displayName trims a person's chosen name; an empty result clears it so screens fall back to the email.
func displayName(value string) (string, bool) {
	name := strings.TrimSpace(value)
	if utf8.RuneCountInString(name) > 40 || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", false
	}
	return name, true
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request, session Session) {
	if _, err := s.pool.Exec(r.Context(), `DELETE FROM sessions WHERE token_hash = $1`, session.tokenHash); err != nil {
		internal(w, "logout", err)
		return
	}

	if session.Kind == "web" {
		http.SetCookie(w, s.cookie(webSessionCookie, "", -1e9))
	}
	w.WriteHeader(http.StatusNoContent)
}
