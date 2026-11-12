package collaboration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func reviewDocuments(ctx context.Context, view gitView, base, head string) ([]byte, []byte, error) {
	read := func(oid string) ([]byte, error) {
		if !gitOID.MatchString(oid) || oid == zeroCommit {
			return nil, receiveRejection("invalid_review_commit")
		}
		return view.read(ctx, projectDocumentLimit, "cat-file", "blob", oid+":project.json")
	}
	left, err := read(base)
	if err != nil {
		return nil, nil, err
	}
	right, err := read(head)
	return left, right, err
}

type reviewMergeInputs struct {
	ancestorOID string
	result      ToolResult
}

func (s *Server) mergeInputs(ctx context.Context, view gitView, target review, resolutions []byte) (reviewMergeInputs, error) {
	output, err := view.read(ctx, 4096, "merge-base", "--all", target.BaseOID, target.HeadOID)
	if err != nil {
		return reviewMergeInputs{}, receiveRejection("review_ancestor_unavailable")
	}
	ancestors := strings.Fields(string(output))
	if len(ancestors) != 1 || !gitOID.MatchString(ancestors[0]) {
		return reviewMergeInputs{}, receiveRejection("review_ancestor_ambiguous")
	}

	ancestor, err := view.read(ctx, projectDocumentLimit, "cat-file", "blob", ancestors[0]+":project.json")
	if err != nil {
		return reviewMergeInputs{}, err
	}
	base, head, err := reviewDocuments(ctx, view, target.BaseOID, target.HeadOID)
	if err != nil {
		return reviewMergeInputs{}, err
	}

	result, err := s.projectTool.Merge(ctx, ancestor, base, head, resolutions)
	return reviewMergeInputs{ancestorOID: ancestors[0], result: result}, err
}

func reviewResolutions(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, mergeResolutionLimit))
	if err != nil {
		problem(w, http.StatusBadRequest, "invalid_resolutions")
		return nil, false
	}

	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, true
	}
	return raw, true
}

func (s *Server) validateReview(w http.ResponseWriter, r *http.Request, _ Session, project reviewProject) {
	if !project.role.canWrite() {
		problem(w, http.StatusForbidden, "insufficient_role")
		return
	}
	resolutions, ok := reviewResolutions(w, r)
	if !ok {
		return
	}

	ctx := r.Context()
	target, err := readReview(ctx, s.pool, project.id, r.PathValue("review"))
	if err != nil {
		reviewError(w, "validate_review", err)
		return
	}
	refs, err := listReviewRefs(ctx, project.view)
	if err == nil {
		err = s.hydrateReview(ctx, project.view, refs, &target)
	}
	if err != nil {
		reviewError(w, "validate_review_state", err)
		return
	}
	if target.State != "open" {
		problem(w, http.StatusConflict, "review_not_current")
		return
	}

	prepared, err := s.mergeInputs(ctx, project.view, target, resolutions)
	if err != nil {
		reviewError(w, "review_validation", err)
		return
	}
	status := "conflict"
	if prepared.result.OK {
		status = "clean"
	}

	var envelope struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(prepared.result.Document, &envelope); err != nil {
		internal(w, "review_validation_result", err)
		return
	}
	if envelope.Code == "invalid_resolution" {
		problem(w, http.StatusBadRequest, "invalid_resolutions")
		return
	}

	if _, err := s.pool.Exec(ctx, `UPDATE reviews SET validation = $2 WHERE id = $1 AND merged_oid IS NULL`, target.ID, status); err != nil {
		internal(w, "record_review_validation", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"validation": status, "ancestor_oid": prepared.ancestorOID, "merge": prepared.result})
}

func (s *Server) mergeReview(w http.ResponseWriter, r *http.Request, session Session, project reviewProject) {
	if project.role != Owner {
		problem(w, http.StatusForbidden, "insufficient_role")
		return
	}
	resolutions, ok := reviewResolutions(w, r)
	if !ok {
		return
	}

	select {
	case s.receive.slots <- struct{}{}:
		defer func() { <-s.receive.slots }()
	default:
		problem(w, http.StatusServiceUnavailable, "receive_busy")
		return
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		internal(w, "begin_review_merge", err)
		return
	}
	defer tx.Rollback(ctx)
	if err := lockProject(ctx, tx, project.id); err != nil {
		requireRole(w, "", err, false)
		return
	}

	var role Role
	err = tx.QueryRow(ctx, `SELECT m.role FROM memberships m JOIN sessions s ON s.account_id = m.account_id
 WHERE m.project_id = $1 AND m.account_id = $2 AND s.token_hash = $3 AND s.expires_at > now() FOR SHARE OF s`,
		project.id, session.AccountID, session.tokenHash).Scan(&role)
	if !requireRole(w, role, err, role == Owner) {
		return
	}

	target, err := readReview(ctx, tx, project.id, r.PathValue("review"))
	if err != nil {
		reviewError(w, "merge_review", err)
		return
	}
	refs, err := listReviewRefs(ctx, project.view)
	if err == nil {
		err = s.hydrateReview(ctx, project.view, refs, &target)
	}
	if err != nil {
		reviewError(w, "merge_review_state", err)
		return
	}
	if target.State == "merged" {
		writeJSON(w, http.StatusOK, target)
		return
	}
	if target.State != "open" {
		problem(w, http.StatusConflict, "review_not_current")
		return
	}

	prepared, err := s.mergeInputs(ctx, project.view, target, resolutions)
	if err != nil {
		reviewError(w, "prepare_review_merge", err)
		return
	}
	if !prepared.result.OK {
		var envelope struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(prepared.result.Document, &envelope); err != nil {
			internal(w, "prepare_review_result", err)
			return
		}
		if envelope.Code == "invalid_resolution" {
			problem(w, http.StatusBadRequest, "invalid_resolutions")
			return
		}
		writeJSON(w, http.StatusConflict, map[string]any{"error": "review_conflict", "merge": prepared.result})
		return
	}

	var song string
	if err := tx.QueryRow(ctx, `SELECT coalesce(song_id,'') FROM projects WHERE id = $1`, project.id).Scan(&song); err != nil {
		internal(w, "review_song_id", err)
		return
	}
	if song == "" {
		problem(w, http.StatusConflict, "initialize_shared_branch_first")
		return
	}

	commit, err := s.prepareReviewCommit(ctx, project.view, target, prepared, session.Email)
	if err != nil {
		reviewError(w, "prepare_review_commit", err)
		return
	}
	validated, err := s.validateVersionTree(ctx, project.view, project.id, commit, make(map[lfsObject]bool))
	if err != nil {
		reviewError(w, "verify_review_candidate", err)
		return
	}
	if validated.ProjectID != song {
		problem(w, http.StatusConflict, "project_identity_mismatch")
		return
	}

	// A durable intent allows status to recover if Git succeeds and the database response is lost.
	if _, err := project.view.write(ctx, nil, nil, "update-ref", reviewRef(target.ID, "attempts/"+commit), commit); err != nil {
		internal(w, "pin_review_merge_intent", err)
		return
	}
	if _, err := s.pool.Exec(ctx, `UPDATE reviews SET pending_oid = $2, validation = 'clean' WHERE id = $1`, target.ID, commit); err != nil {
		internal(w, "persist_review_merge_intent", err)
		return
	}

	transaction := "start\nverify " + target.SourceRef + " " + target.HeadOID + "\nupdate " + sharedBranch + " " + commit + " " + target.BaseOID +
		"\nupdate " + reviewRef(target.ID, "merge") + " " + commit + "\nprepare\ncommit\n"
	if _, err := project.view.write(ctx, nil, strings.NewReader(transaction), "update-ref", "--stdin"); err != nil {
		problem(w, http.StatusConflict, "review_ref_changed")
		return
	}

	if _, err := tx.Exec(ctx, `UPDATE reviews SET merged_oid = $2 WHERE id = $1 AND pending_oid = $2`, target.ID, commit); err != nil {
		internal(w, "record_review_merge", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		internal(w, "commit_review_merge", err)
		return
	}

	target.State, target.MergedOID, target.Validation = "merged", commit, "clean"
	writeJSON(w, http.StatusOK, target)
}

func reviewRef(id, kind string) string {
	return "refs/ayotbi/reviews/" + id + "/" + kind
}

func (view gitView) write(ctx context.Context, environment []string, input io.Reader, args ...string) ([]byte, error) {
	cmd := gitCommand(ctx, view.repositories.git, view.directory, args...)
	cmd.Env = append(cmd.Env, environment...)
	cmd.Stdin = input
	output := cappedBuffer{limit: 4 << 20}
	cmd.Stdout = &output
	if err := cmd.Run(); err != nil {
		return nil, err
	}

	return output.buffer.Bytes(), nil
}

func (s *Server) prepareReviewCommit(ctx context.Context, view gitView, target review, prepared reviewMergeInputs, email string) (string, error) {
	var merged struct {
		Project json.RawMessage `json:"project"`
	}
	if err := json.Unmarshal(prepared.result.Document, &merged); err != nil || len(merged.Project) == 0 {
		return "", errors.New("merge did not produce a project")
	}
	document := append(merged.Project, '\n')
	manifestResult, err := s.projectTool.VersionManifest(ctx, document)
	if err != nil {
		return "", err
	}
	var manifest versionManifest
	if !manifestResult.OK || json.Unmarshal(manifestResult.Document, &manifest) != nil {
		return "", receiveRejection("invalid_project_version")
	}

	files := make(map[string]string)
	blobs := map[string][]byte{"project.json": document}
	for path, value := range manifest.Metadata {
		blobs[path] = []byte(value)
	}
	for path, value := range blobs {
		oid, err := view.write(ctx, nil, bytes.NewReader(value), "hash-object", "-w", "--stdin")
		if err != nil {
			return "", err
		}
		files[path] = strings.TrimSpace(string(oid))
	}

	for _, source := range []string{target.BaseOID, target.HeadOID, prepared.ancestorOID} {
		tree, err := readVersionTree(ctx, view, source)
		if err != nil {
			return "", err
		}
		for path := range manifest.Media {
			if _, found := files[path]; !found && tree[path].OID != "" {
				files[path] = tree[path].OID
			}
		}
	}
	if len(files) != len(manifest.Media)+len(blobs) {
		return "", receiveRejection("required_lfs_pointer_missing")
	}

	stage, err := os.MkdirTemp("", "ayotbi-review-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	environment := []string{"GIT_INDEX_FILE=" + filepath.Join(stage, "index")}
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	var index strings.Builder
	for _, path := range paths {
		oid := files[path]
		if !gitOID.MatchString(oid) || strings.ContainsAny(path, "\x00\t\n") {
			return "", receiveRejection("invalid_merge_tree")
		}
		index.WriteString("100644 blob " + oid + "\t" + path + "\x00")
	}
	if _, err := view.write(ctx, environment, strings.NewReader(index.String()), "update-index", "-z", "--index-info"); err != nil {
		return "", err
	}

	rawTree, err := view.write(ctx, environment, nil, "write-tree")
	if err != nil {
		return "", err
	}
	tree := strings.TrimSpace(string(rawTree))
	if !gitOID.MatchString(tree) {
		return "", receiveRejection("invalid_merge_tree")
	}

	if _, err := verifiedEmail(email); err != nil {
		return "", err
	}
	environment = []string{"GIT_AUTHOR_NAME=Ayotbi", "GIT_COMMITTER_NAME=Ayotbi",
		"GIT_AUTHOR_EMAIL=" + email, "GIT_COMMITTER_EMAIL=" + email}
	message := target.Title + "\n\nAyotbi-Review: " + target.ID + "\n"
	rawCommit, err := view.write(ctx, environment, strings.NewReader(message), "commit-tree", tree, "-p", target.BaseOID, "-p", target.HeadOID, "-F", "-")
	if err != nil {
		return "", err
	}

	commit := strings.TrimSpace(string(rawCommit))
	if !gitOID.MatchString(commit) {
		return "", receiveRejection("invalid_merge_commit")
	}
	return commit, nil
}
