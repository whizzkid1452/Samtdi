package collaboration

import (
	"embed"
	"errors"
	"html/template"
	"net/http"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
)

//go:embed review_web/*
var reviewWeb embed.FS

var reviewTemplate = template.Must(template.ParseFS(reviewWeb, "review_web/index.html"))

func safeReviewReturn(path string) bool {
	parts := strings.Split(path, "/")
	if len(parts) < 2 || len(parts) > 4 || parts[0] != "" || parts[1] != "review" {
		return false
	}
	for _, part := range parts[2:] {
		if !uuidPattern.MatchString(part) {
			return false
		}
	}
	return true
}

func (s *Server) reviewWebRoutes() {
	s.mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/review", http.StatusSeeOther)
	})
	s.mux.HandleFunc("GET /review", s.webReview)
	s.mux.HandleFunc("GET /review/{project}", s.webReview)
	s.mux.HandleFunc("GET /review/{project}/{review}", s.webReview)

	for _, asset := range []struct{ name, mime string }{
		{"review.css", "text/css; charset=utf-8"}, {"review.js", "text/javascript; charset=utf-8"},
	} {
		raw, err := reviewWeb.ReadFile("review_web/" + asset.name)
		if err != nil {
			panic(err)
		}
		s.mux.HandleFunc("GET /review-assets/"+asset.name, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", asset.mime)
			_, _ = w.Write(raw)
		})
	}
}

func (s *Server) webReview(w http.ResponseWriter, r *http.Request) {
	if !safeReviewReturn(r.URL.Path) || r.URL.EscapedPath() != r.URL.Path {
		http.NotFound(w, r)
		return
	}

	session, err := s.authenticate(r, false)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && session.Kind != "web") {
		target := "/v1/auth/login?" + url.Values{"return_to": {r.URL.Path}}.Encode()
		http.Redirect(w, r, target, http.StatusSeeOther)
		return
	}
	if err != nil {
		internal(w, "review_web_session", err)
		return
	}

	if err := s.loadOrganizations(r.Context(), &session); err != nil {
		writeWebError(w, "load_review_organizations", err)
		return
	}

	projectID, reviewID := r.PathValue("project"), r.PathValue("review")
	var role Role
	if projectID != "" {
		if err := s.authorizeWorkspaceProject(r.Context(), projectID, session); err != nil {
			writeWebError(w, "authorize_review_workspace", err)
			return
		}
		role, err = readRole(r.Context(), s.pool, projectID, session.AccountID)
		if !requireRole(w, role, err, role.valid()) {
			return
		}
	}
	if reviewID != "" {
		if _, err := readReview(r.Context(), s.pool, projectID, reviewID); err != nil {
			reviewError(w, "web_review", err)
			return
		}
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
	_ = reviewTemplate.Execute(w, struct {
		Project, Review, AccountLabel string
		CanWrite, CanMerge            bool
	}{projectID, reviewID, accountLabel(session), role.canWrite(), role == Owner})
}

func accountLabel(session Session) string {
	if session.Name != "" {
		return session.Name
	}
	return session.Email
}
