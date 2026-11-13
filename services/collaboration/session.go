package collaboration

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const webSessionCookie = "ayotbi_session"

type Session struct {
	AccountID string `json:"account_id"`
	Email     string `json:"email"`
	Kind      string `json:"kind"`
	tokenHash []byte
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
	err := s.pool.QueryRow(r.Context(), `SELECT a.id::text, a.email FROM sessions s
 JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1 AND s.kind = $2 AND s.expires_at > now()`,
		session.tokenHash, kind).Scan(&session.AccountID, &session.Email)
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

		handler(w, r, session)
	}
}

func (s *Server) me(w http.ResponseWriter, _ *http.Request, session Session) {
	writeJSON(w, http.StatusOK, session)
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
