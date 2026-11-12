package collaboration

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

type review struct {
	ID         string    `json:"id"`
	ProjectID  string    `json:"project_id"`
	AuthorID   string    `json:"author_id"`
	Title      string    `json:"title"`
	SourceRef  string    `json:"source_ref"`
	BaseOID    string    `json:"base_oid"`
	HeadOID    string    `json:"head_oid"`
	Validation string    `json:"validation"`
	PendingOID string    `json:"-"`
	MergedOID  string    `json:"merged_oid,omitempty"`
	State      string    `json:"state"`
	CreatedAt  time.Time `json:"created_at"`
}

const reviewColumns = `id::text, project_id::text, author_id::text, title, source_ref, base_oid, head_oid,
 validation, coalesce(pending_oid, ''), coalesce(merged_oid, ''), created_at`

func scanReview(row pgx.Row) (review, error) {
	var result review
	err := row.Scan(&result.ID, &result.ProjectID, &result.AuthorID, &result.Title, &result.SourceRef, &result.BaseOID, &result.HeadOID,
		&result.Validation, &result.PendingOID, &result.MergedOID, &result.CreatedAt)
	return result, err
}

type reviewProject struct {
	id   string
	role Role
	view gitView
}

type reviewProjectHandler func(http.ResponseWriter, *http.Request, Session, reviewProject)

func (s *Server) withReviewProject(handler reviewProjectHandler) http.HandlerFunc {
	return s.withSession(func(w http.ResponseWriter, r *http.Request, session Session) {
		projectID := r.PathValue("project")
		role, err := readRole(r.Context(), s.pool, projectID, session.AccountID)
		if !requireRole(w, role, err, role.valid()) {
			return
		}

		folder, err := s.git.repository(r.Context(), projectID)
		if err != nil {
			internal(w, "review_repository", err)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), receiveValidationTimeout)
		defer cancel()
		deadline, _ := ctx.Deadline()
		response := http.NewResponseController(w)
		_ = response.SetReadDeadline(deadline)
		_ = response.SetWriteDeadline(deadline)

		handler(w, r.WithContext(ctx), session, reviewProject{id: projectID, role: role, view: gitView{repositories: s.git, directory: folder}})
	})
}

func (s *Server) reviewRoutes() {
	prefix := "/v1/projects/{project}/reviews"
	detail := prefix + "/{review}"
	s.mux.HandleFunc("GET "+prefix, s.withReviewProject(s.listReviews))
	s.mux.HandleFunc("POST "+prefix, s.withReviewProject(s.createReview))
	s.mux.HandleFunc("GET "+detail, s.withReviewProject(s.getReview))
	s.mux.HandleFunc("GET "+detail+"/diff", s.withReviewProject(s.reviewDiff))
	s.mux.HandleFunc("GET "+detail+"/comments", s.withReviewProject(s.listReviewComments))
	s.mux.HandleFunc("POST "+detail+"/comments", s.withReviewProject(s.createReviewComment))
	s.mux.HandleFunc("POST "+detail+"/validate", s.withReviewProject(s.validateReview))
	s.mux.HandleFunc("POST "+detail+"/merge", s.withReviewProject(s.mergeReview))
}

func readReview(ctx context.Context, db rowQuerier, projectID, id string) (review, error) {
	if !uuidPattern.MatchString(id) {
		return review{}, pgx.ErrNoRows
	}
	return scanReview(db.QueryRow(ctx, `SELECT `+reviewColumns+` FROM reviews WHERE project_id = $1 AND id = $2`, projectID, id))
}

func reviewError(w http.ResponseWriter, operation string, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, http.StatusNotFound, "review_not_found")
		return
	}

	var rejected receiveRejection
	if errors.As(err, &rejected) {
		problem(w, http.StatusConflict, string(rejected))
		return
	}

	internal(w, operation, err)
}

func listReviewRefs(ctx context.Context, view gitView) (map[string]string, error) {
	raw, err := view.read(ctx, 4<<20, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/")
	if err != nil {
		return nil, err
	}

	refs := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		name, oid, ok := strings.Cut(line, " ")
		if ok && gitOID.MatchString(oid) {
			refs[name] = oid
		}
	}

	return refs, nil
}

func (s *Server) hydrateReview(ctx context.Context, view gitView, refs map[string]string, result *review) error {
	target := refs[sharedBranch]
	if result.MergedOID == "" && result.PendingOID != "" && target != "" {
		ancestor, err := view.isAncestor(ctx, result.PendingOID, target)
		if err != nil {
			return err
		}
		if ancestor {
			_, err := s.pool.Exec(ctx, `UPDATE reviews SET merged_oid = $2 WHERE id = $1 AND pending_oid = $2`, result.ID, result.PendingOID)
			if err != nil {
				return err
			}
			result.MergedOID = result.PendingOID
		}
	}

	switch {
	case result.MergedOID != "":
		result.State = "merged"
	case refs[result.SourceRef] != result.HeadOID || target != result.BaseOID:
		result.State = "stale"
	default:
		result.State = "open"
	}

	return nil
}

func (view gitView) isAncestor(ctx context.Context, older, newer string) (bool, error) {
	cmd := gitCommand(ctx, view.repositories.git, view.directory, "merge-base", "--is-ancestor", older, newer)
	err := cmd.Run()
	if cmd.ProcessState != nil && cmd.ProcessState.ExitCode() == 1 {
		return false, nil
	}
	return err == nil, err
}

func (s *Server) listReviews(w http.ResponseWriter, r *http.Request, _ Session, project reviewProject) {
	ctx := r.Context()
	rows, err := s.pool.Query(ctx, `SELECT `+reviewColumns+` FROM reviews WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, project.id)
	if err != nil {
		internal(w, "list_reviews", err)
		return
	}

	reviews, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (review, error) { return scanReview(row) })
	if err != nil {
		internal(w, "read_reviews", err)
		return
	}
	refs, err := listReviewRefs(ctx, project.view)
	if err != nil {
		internal(w, "review_refs", err)
		return
	}

	for i := range reviews {
		if err := s.hydrateReview(ctx, project.view, refs, &reviews[i]); err != nil {
			internal(w, "review_state", err)
			return
		}
	}

	writeJSON(w, http.StatusOK, reviews)
}

func (s *Server) getReview(w http.ResponseWriter, r *http.Request, _ Session, project reviewProject) {
	result, err := readReview(r.Context(), s.pool, project.id, r.PathValue("review"))
	if err != nil {
		reviewError(w, "read_review", err)
		return
	}

	refs, err := listReviewRefs(r.Context(), project.view)
	if err == nil {
		err = s.hydrateReview(r.Context(), project.view, refs, &result)
	}
	if err != nil {
		reviewError(w, "review_state", err)
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func (s *Server) createReview(w http.ResponseWriter, r *http.Request, session Session, project reviewProject) {
	if !project.role.canWrite() {
		problem(w, http.StatusForbidden, "insufficient_role")
		return
	}

	var input struct {
		Title        string `json:"title"`
		SourceBranch string `json:"source_branch"`
	}
	if !readJSON(w, r, &input) {
		return
	}

	title := strings.TrimSpace(input.Title)
	source := "refs/heads/" + input.SourceBranch
	if title == "" || utf8.RuneCountInString(title) > 160 || strings.IndexFunc(title, unicode.IsControl) >= 0 ||
		len(input.SourceBranch) == 0 || len(input.SourceBranch) > 256 || source == sharedBranch {
		problem(w, http.StatusBadRequest, "invalid_review")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		internal(w, "begin_review", err)
		return
	}
	defer tx.Rollback(ctx)
	if err := lockProject(ctx, tx, project.id); err != nil {
		requireRole(w, "", err, false)
		return
	}
	role, err := readRole(ctx, tx, project.id, session.AccountID)
	if !requireRole(w, role, err, role.canWrite()) {
		return
	}

	refs, err := listReviewRefs(ctx, project.view)
	if err != nil {
		internal(w, "read_review_refs", err)
		return
	}
	base, head := refs[sharedBranch], refs[source]
	if base == "" || head == "" || base == head {
		problem(w, http.StatusConflict, "review_branches_unavailable")
		return
	}
	alreadyIncluded, err := project.view.isAncestor(ctx, head, base)
	if err != nil {
		internal(w, "review_ancestry", err)
		return
	}
	if alreadyIncluded {
		problem(w, http.StatusConflict, "review_already_included")
		return
	}

	created, err := scanReview(tx.QueryRow(ctx, `INSERT INTO reviews (project_id,author_id,title,source_ref,base_oid,head_oid)
 VALUES ($1,$2,$3,$4,$5,$6)
 ON CONFLICT (project_id,source_ref,base_oid,head_oid) DO UPDATE SET title = reviews.title
 RETURNING `+reviewColumns, project.id, session.AccountID, title, source, base, head))
	if err != nil {
		internal(w, "insert_review", err)
		return
	}
	pin := "start\nverify " + sharedBranch + " " + base + "\nverify " + source + " " + head +
		"\nupdate " + reviewRef(created.ID, "base") + " " + base + "\nupdate " + reviewRef(created.ID, "head") + " " + head + "\nprepare\ncommit\n"
	if _, err := project.view.write(ctx, nil, strings.NewReader(pin), "update-ref", "--stdin"); err != nil {
		problem(w, http.StatusConflict, "review_ref_changed")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		internal(w, "commit_review", err)
		return
	}

	created.State = "open"
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) reviewDiff(w http.ResponseWriter, r *http.Request, _ Session, project reviewProject) {
	ctx := r.Context()
	target, err := readReview(ctx, s.pool, project.id, r.PathValue("review"))
	if err != nil {
		reviewError(w, "diff_review", err)
		return
	}

	base, head, err := reviewDocuments(ctx, project.view, target.BaseOID, target.HeadOID)
	if err != nil {
		reviewError(w, "read_diff_documents", err)
		return
	}
	diff, err := s.projectTool.MusicDiff(ctx, base, head)
	if err != nil || !diff.OK {
		problem(w, http.StatusConflict, "review_diff_unavailable")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"base_oid": target.BaseOID, "head_oid": target.HeadOID, "diff": diff})
}

type reviewComment struct {
	ID            string    `json:"id"`
	AuthorID      string    `json:"author_id"`
	CommitOID     string    `json:"commit_oid"`
	Body          string    `json:"body"`
	PositionTicks *int64    `json:"position_ticks"`
	CreatedAt     time.Time `json:"created_at"`
}

func scanReviewComment(row pgx.Row) (reviewComment, error) {
	var result reviewComment
	err := row.Scan(&result.ID, &result.AuthorID, &result.CommitOID, &result.Body, &result.PositionTicks, &result.CreatedAt)
	return result, err
}

func (s *Server) listReviewComments(w http.ResponseWriter, r *http.Request, _ Session, project reviewProject) {
	target, err := readReview(r.Context(), s.pool, project.id, r.PathValue("review"))
	if err != nil {
		reviewError(w, "comments_review", err)
		return
	}

	rows, err := s.pool.Query(r.Context(), `SELECT id::text,author_id::text,commit_oid,body,position_ticks,created_at
 FROM review_comments WHERE review_id = $1 ORDER BY created_at DESC,id DESC LIMIT 200`, target.ID)
	if err != nil {
		internal(w, "list_review_comments", err)
		return
	}
	comments, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (reviewComment, error) { return scanReviewComment(row) })
	if err != nil {
		internal(w, "read_review_comments", err)
		return
	}

	writeJSON(w, http.StatusOK, comments)
}

func (s *Server) createReviewComment(w http.ResponseWriter, r *http.Request, session Session, project reviewProject) {
	var input struct {
		CommitOID     string `json:"commit_oid"`
		Body          string `json:"body"`
		PositionTicks *int64 `json:"position_ticks"`
	}
	if !readJSON(w, r, &input) {
		return
	}

	target, err := readReview(r.Context(), s.pool, project.id, r.PathValue("review"))
	if err != nil {
		reviewError(w, "comment_review", err)
		return
	}
	body := strings.TrimSpace(input.Body)
	if (input.CommitOID != target.BaseOID && input.CommitOID != target.HeadOID) || body == "" ||
		utf8.RuneCountInString(body) > 4000 || strings.ContainsRune(body, 0) || (input.PositionTicks != nil && *input.PositionTicks < 0) {
		problem(w, http.StatusBadRequest, "invalid_review_comment")
		return
	}

	comment, err := scanReviewComment(s.pool.QueryRow(r.Context(), `INSERT INTO review_comments (review_id,author_id,commit_oid,body,position_ticks)
 SELECT $1,$2,$3,$4,$5 FROM memberships WHERE project_id = $6 AND account_id = $2
 RETURNING id::text,author_id::text,commit_oid,body,position_ticks,created_at`, target.ID, session.AccountID, input.CommitOID, body, input.PositionTicks, project.id))
	if err != nil {
		reviewError(w, "insert_review_comment", err)
		return
	}

	writeJSON(w, http.StatusCreated, comment)
}
