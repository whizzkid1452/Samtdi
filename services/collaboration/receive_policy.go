package collaboration

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	sharedBranch       = "refs/heads/main"
	zeroCommit         = "0000000000000000000000000000000000000000"
	emptyBlobHash      = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	maxReceivedCommits = 256
)

var gitOID = regexp.MustCompile(`^[0-9a-f]{40}$`)

type receiveRejection string

func (reason receiveRejection) Error() string { return string(reason) }

type gitRefUpdate struct {
	old, new, ref string
}

func parseRefUpdates(data []byte) ([]gitRefUpdate, error) {
	var updates []gitRefUpdate
	seen := make(map[string]bool)
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		parts := strings.Split(line, " ")
		if len(parts) != 3 || !gitOID.MatchString(parts[0]) || !gitOID.MatchString(parts[1]) ||
			!strings.HasPrefix(parts[2], "refs/heads/") || seen[parts[2]] || len(updates) >= 128 {
			return nil, receiveRejection("invalid_ref_update")
		}

		seen[parts[2]] = true
		updates = append(updates, gitRefUpdate{old: parts[0], new: parts[1], ref: parts[2]})
	}

	return updates, nil
}

type gitView struct {
	repositories *GitRepositories
	directory    string
	quarantine   string
}

func (view gitView) read(ctx context.Context, limit int, args ...string) ([]byte, error) {
	command := gitCommand(ctx, view.repositories.git, view.directory, args...)
	if view.quarantine != "" {
		command.Env = append(command.Env, "GIT_OBJECT_DIRECTORY="+view.quarantine,
			"GIT_ALTERNATE_OBJECT_DIRECTORIES="+strconv.Quote(filepath.Join(view.directory, "objects")))
	}
	output := cappedBuffer{limit: limit}
	command.Stdout = &output
	if err := command.Run(); err != nil {
		return nil, err
	}

	return output.buffer.Bytes(), nil
}

func quarantineDirectory(repo, location string) (string, error) {
	if location == "" {
		return "", nil
	}

	expected := filepath.Join(repo, "objects")
	resolved, err := filepath.EvalSymlinks(location)
	if err != nil || filepath.Dir(resolved) != expected || !strings.HasPrefix(filepath.Base(resolved), "tmp_objdir-incoming-") {
		return "", receiveRejection("invalid_git_quarantine")
	}

	return resolved, nil
}

func (s *Server) validateReceive(ctx context.Context, scope receiveScope, location string, input []byte) (string, error) {
	updates, err := parseRefUpdates(input)
	if err != nil {
		return "", err
	}
	quarantine, err := quarantineDirectory(scope.repository, location)
	if err != nil {
		return "", err
	}

	view := gitView{repositories: s.git, directory: scope.repository, quarantine: quarantine}
	args := []string{"rev-list", "--topo-order", "--max-count=" + strconv.Itoa(maxReceivedCommits+1)}
	tips := make(map[string]bool)
	initializesMain := false
	for _, update := range updates {
		if update.ref == sharedBranch && (scope.role != Owner || update.old != zeroCommit || update.new == zeroCommit) {
			return "", receiveRejection("shared_branch_protected")
		}
		if update.ref == sharedBranch {
			initializesMain = true
		}
		if update.new == zeroCommit {
			continue
		}

		tips[update.new] = true
		args = append(args, update.new)
	}

	if scope.songID == "" {
		existing, err := view.read(ctx, 4096, "for-each-ref", "--format=%(refname)", sharedBranch)
		if err != nil {
			return "", err
		}
		if string(existing) != sharedBranch+"\n" && (scope.role != Owner || !initializesMain) {
			return "", receiveRejection("initialize_shared_branch_first")
		}

		// An older store may contain references written before the validation gate was installed.
		args = append(args, "--all")
	} else {
		if len(tips) == 0 {
			return scope.songID, nil
		}
		args = append(args, "--not", "--all")
	}
	revisions, err := view.read(ctx, 32<<10, args...)
	if err != nil {
		return "", receiveRejection("invalid_commit_graph")
	}
	commits := strings.Fields(string(revisions))
	if len(commits) > maxReceivedCommits {
		return "", receiveRejection("too_many_commits")
	}

	for _, commit := range commits {
		tips[commit] = true
	}
	if len(tips) > maxReceivedCommits {
		return "", receiveRejection("too_many_commits")
	}

	song := scope.songID
	checkedMedia := make(map[lfsObject]bool)
	for commit := range tips {
		manifest, err := s.validateVersionTree(ctx, view, scope.projectID, commit, checkedMedia)
		if err != nil {
			return "", err
		}
		if song != "" && manifest.ProjectID != song {
			return "", receiveRejection("project_identity_mismatch")
		}

		song = manifest.ProjectID
	}

	return song, nil
}

type versionManifest struct {
	SourceHash string            `json:"sourceHash"`
	ProjectID  string            `json:"projectId"`
	Media      map[string]string `json:"media"`
	Metadata   map[string]string `json:"metadata"`
}

type versionTreeEntry struct {
	OID  string
	Size int
}

func readVersionTree(ctx context.Context, view gitView, commit string) (map[string]versionTreeEntry, error) {
	if !gitOID.MatchString(commit) || commit == zeroCommit {
		return nil, receiveRejection("invalid_commit_id")
	}

	object, err := view.read(ctx, 64, "cat-file", "-t", commit)
	if err != nil || string(object) != "commit\n" {
		return nil, receiveRejection("invalid_commit_type")
	}
	tree, err := view.read(ctx, 4<<20, "ls-tree", "-r", "-z", "-l", commit)
	if err != nil || len(tree) == 0 {
		return nil, receiveRejection("invalid_version_tree")
	}

	files := make(map[string]versionTreeEntry)
	for _, row := range bytes.Split(bytes.TrimSuffix(tree, []byte{0}), []byte{0}) {
		attributes, path, ok := strings.Cut(string(row), "\t")
		fields := strings.Fields(attributes)
		if !ok || len(fields) != 4 || fields[0] != "100644" || fields[1] != "blob" || !gitOID.MatchString(fields[2]) {
			return nil, receiveRejection("invalid_version_entry")
		}

		size, err := strconv.Atoi(fields[3])
		if err != nil || size < 0 {
			return nil, receiveRejection("invalid_version_entry")
		}
		if _, exists := files[path]; exists {
			return nil, receiveRejection("duplicate_version_path")
		}
		files[path] = versionTreeEntry{OID: fields[2], Size: size}
	}

	return files, nil
}

func readVersionBlob(ctx context.Context, view gitView, entry versionTreeEntry, limit int) ([]byte, error) {
	if entry.OID == "" || entry.Size > limit {
		return nil, receiveRejection("version_file_missing_or_large")
	}

	raw, err := view.read(ctx, limit, "cat-file", "blob", entry.OID)
	if err != nil || len(raw) != entry.Size {
		return nil, receiveRejection("invalid_version_blob")
	}

	return raw, nil
}

func (s *Server) validateVersionTree(ctx context.Context, view gitView, projectID, commit string, verified map[lfsObject]bool) (versionManifest, error) {
	files, err := readVersionTree(ctx, view, commit)
	if err != nil {
		return versionManifest{}, err
	}

	projectJSON, err := readVersionBlob(ctx, view, files["project.json"], projectDocumentLimit)
	if err != nil {
		return versionManifest{}, err
	}
	result, err := s.projectTool.VersionManifest(ctx, projectJSON)
	if err != nil {
		return versionManifest{}, err
	}

	var manifest versionManifest
	if !result.OK || json.Unmarshal(result.Document, &manifest) != nil || manifest.ProjectID == "" ||
		len(manifest.Metadata) != 2 || len(files) != 1+len(manifest.Metadata)+len(manifest.Media) {
		return versionManifest{}, receiveRejection("invalid_project_version")
	}

	for path, expected := range manifest.Metadata {
		content, err := readVersionBlob(ctx, view, files[path], 1024)
		if err != nil || string(content) != expected {
			return versionManifest{}, receiveRejection("invalid_version_metadata")
		}
	}

	for path, digest := range manifest.Media {
		pointer, err := readVersionBlob(ctx, view, files[path], 256)
		if err != nil {
			return versionManifest{}, err
		}
		if len(pointer) == 0 && digest == emptyBlobHash && strings.HasPrefix(path, "plugin-states/") {
			continue
		}

		object, err := parseLFSPointer(pointer, digest)
		if err != nil {
			return versionManifest{}, err
		}
		if verified[object] {
			continue
		}

		present, err := s.hasLFSObject(ctx, projectID, object)
		if err != nil {
			return versionManifest{}, err
		}
		if !present {
			return versionManifest{}, receiveRejection("required_lfs_object_missing")
		}

		verified[object] = true
	}

	return manifest, nil
}

func parseLFSPointer(raw []byte, digest string) (lfsObject, error) {
	parts := strings.Split(string(raw), "\n")
	if len(parts) != 4 || parts[0] != "version https://git-lfs.github.com/spec/v1" ||
		parts[1] != "oid sha256:"+digest || !strings.HasPrefix(parts[2], "size ") || parts[3] != "" {
		return lfsObject{}, receiveRejection("invalid_lfs_pointer")
	}

	sizeText := strings.TrimPrefix(parts[2], "size ")
	size, err := strconv.ParseInt(sizeText, 10, 64)
	object := lfsObject{OID: digest, Size: size}
	if err != nil || strconv.FormatInt(size, 10) != sizeText || !object.valid() {
		return lfsObject{}, receiveRejection("invalid_lfs_pointer")
	}

	return object, nil
}

func (s *Server) guardedReceive(ctx context.Context, w http.ResponseWriter, r *http.Request, session Session, projectID, repo, path string, body *os.File, size int64) {
	select {
	case s.receive.slots <- struct{}{}:
		defer func() { <-s.receive.slots }()
	default:
		problem(w, http.StatusServiceUnavailable, "receive_busy")
		return
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		internal(w, "begin_receive", err)
		return
	}
	defer tx.Rollback(ctx)
	if err := lockProject(ctx, tx, projectID); err != nil {
		requireRole(w, "", err, false)
		return
	}

	var role Role
	err = tx.QueryRow(ctx, `SELECT m.role FROM memberships m JOIN sessions s ON s.account_id = m.account_id
 WHERE m.project_id = $1 AND m.account_id = $2 AND s.token_hash = $3 AND s.kind = 'native' AND s.expires_at > now()
 FOR SHARE OF s`, projectID, session.AccountID, session.tokenHash).Scan(&role)
	if !requireRole(w, role, err, role.canWrite()) {
		return
	}

	var boundSong string
	if err := tx.QueryRow(ctx, `SELECT coalesce(song_id,'') FROM projects WHERE id = $1`, projectID).Scan(&boundSong); err != nil {
		internal(w, "read_receive_song", err)
		return
	}

	validated := make(chan string, 1)
	token, environment, err := s.receive.issue(receiveScope{ctx: ctx, projectID: projectID, repository: repo, songID: boundSong, role: role, validated: validated})
	if err != nil {
		internal(w, "prepare_receive_hook", err)
		return
	}
	defer s.receive.consume(token)
	if !s.git.serveBackend(ctx, w, r, session, path, body, size, environment) {
		return
	}

	select {
	case song := <-validated:
		if boundSong != "" || song == "" {
			return
		}
		heads, err := s.git.run(ctx, repo, "rev-parse", "--verify", sharedBranch)
		if err != nil || len(heads) == 0 {
			return
		}

		if _, err := tx.Exec(ctx, `UPDATE projects SET song_id = $2 WHERE id = $1`, projectID, song); err != nil {
			return
		}
		_ = tx.Commit(ctx)
	default:
	}
}
