package collaboration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const renderJobTimeout = 15 * time.Minute

type RendererConfig struct {
	Executable     string
	PluginRegistry string
}

type renderPlugin struct {
	Identity string `json:"identity"`
	XML      string `json:"xml"`
}

type reviewRenderer struct {
	executable     string
	executableInfo os.FileInfo
	hash           string
	plugins        map[string]renderPlugin
	wakeup         chan struct{}
}

func newReviewRenderer(config RendererConfig) (*reviewRenderer, error) {
	if !filepath.IsAbs(config.Executable) {
		return nil, errors.New("render worker path must be absolute")
	}
	if config.PluginRegistry != "" && !filepath.IsAbs(config.PluginRegistry) {
		return nil, errors.New("render plugin registry path must be absolute")
	}

	info, err := os.Stat(config.Executable)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return nil, errors.New("render worker is unavailable")
	}
	executable, err := os.Open(config.Executable)
	if err != nil {
		return nil, errors.New("render worker cannot be read")
	}
	defer executable.Close()

	digest := sha256.New()
	if _, err := io.Copy(digest, executable); err != nil {
		return nil, err
	}
	workerHash := digest.Sum(nil)
	digest.Reset()
	_, _ = digest.Write(workerHash)

	registry := make(map[string]renderPlugin)
	if config.PluginRegistry != "" {
		raw, err := readSmallFile(config.PluginRegistry, 8<<20)
		if err != nil {
			return nil, errors.New("render plugin registry cannot be read")
		}
		var plugins []renderPlugin
		if err := json.Unmarshal(raw, &plugins); err != nil || len(plugins) > 4096 {
			return nil, errors.New("invalid render plugin registry")
		}
		for _, plugin := range plugins {
			if plugin.Identity == "" || plugin.XML == "" || registry[plugin.Identity].Identity != "" {
				return nil, errors.New("invalid render plugin entry")
			}
			registry[plugin.Identity] = plugin
		}
		_, _ = digest.Write(raw)
	}

	return &reviewRenderer{executable: config.Executable, executableInfo: info, hash: hex.EncodeToString(digest.Sum(nil)), plugins: registry, wakeup: make(chan struct{}, 1)}, nil
}

func (renderer *reviewRenderer) wake() {
	select {
	case renderer.wakeup <- struct{}{}:
	default:
	}
}

func (s *Server) RunReviewRenderer(ctx context.Context) {
	if s.renderer == nil {
		return
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for ctx.Err() == nil {
		worked, err := s.workReviewRender(ctx)
		if err != nil && ctx.Err() == nil {
			reportOperation("review_render_queue", err)
		}
		if worked && err == nil {
			continue
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-s.renderer.wakeup:
		}
	}
}

type renderOutcome struct {
	state    string
	reason   string
	manifest json.RawMessage
	digest   string
	size     int64
}

func (s *Server) workReviewRender(ctx context.Context) (bool, error) {
	if _, err := s.pool.Exec(ctx, `UPDATE review_media_versions SET state = 'failed', reason = 'attempts_exhausted',
 finished_at = now(), lease_id = NULL, lease_until = NULL
 WHERE state = 'running' AND lease_until <= now() AND attempts >= 3`); err != nil {
		return false, err
	}

	media, projectID, lease, err := readMediaQueue(ctx, s)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	work, cancel := context.WithTimeout(ctx, renderJobTimeout)
	result := s.renderReviewMedia(work, projectID, media)
	cancel()
	resultContext, finish := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer finish()

	if ctx.Err() != nil {
		_, err := s.pool.Exec(resultContext, `UPDATE review_media_versions SET state = 'queued',
  attempts = attempts - 1, lease_id = NULL, lease_until = NULL WHERE id = $1 AND lease_id = $2`, media.ID, lease)
		return true, err
	}

	_, err = s.pool.Exec(resultContext, `UPDATE review_media_versions SET state = $3, reason = nullif($4,''), manifest = $5,
 mix_oid = nullif($6,''), mix_bytes = nullif($7,0), finished_at = now(), lease_id = NULL, lease_until = NULL
 WHERE id = $1 AND lease_id = $2`, media.ID, lease, result.state, result.reason, result.manifest, result.digest, result.size)
	return true, err
}

func (s *Server) renderReviewMedia(ctx context.Context, projectID string, media reviewMedia) renderOutcome {
	fail := func(reason string) renderOutcome { return renderOutcome{state: "failed", reason: reason} }
	repository, err := s.git.repository(ctx, projectID)
	if err != nil {
		return fail("repository_unavailable")
	}
	view := gitView{repositories: s.git, directory: repository}

	manifest, err := s.validateVersionTree(ctx, view, projectID, media.CommitOID, make(map[lfsObject]bool))
	if err != nil {
		return fail("version_validation_failed")
	}
	if !lfsOID.MatchString(manifest.SourceHash) {
		return fail("source_hash_unavailable")
	}

	document, err := view.read(ctx, projectDocumentLimit, "cat-file", "blob", media.CommitOID+":project.json")
	if err != nil {
		return fail("project_document_unavailable")
	}
	available, missing, err := s.renderer.pluginsForDocument(document)
	if err != nil {
		return fail("plugin_registry_invalid")
	}
	if len(missing) != 0 {
		details, _ := json.Marshal(map[string]any{"missing_plugins": missing, "renderer_hash": media.RendererHash, "sourceHash": manifest.SourceHash})
		return renderOutcome{state: "incomplete", reason: "missing_plugins", manifest: details}
	}

	folder, err := os.MkdirTemp("", "ayotbi-review-render-")
	if err != nil {
		return fail("render_workspace_unavailable")
	}
	defer os.RemoveAll(folder)
	projectFolder := filepath.Join(folder, "project")
	if err := s.stageRenderProject(ctx, view, projectID, media.CommitOID, projectFolder, document, manifest); err != nil {
		return fail("render_media_unavailable")
	}

	hash := sha256.Sum256(document)
	input, err := json.Marshal(map[string]any{
		"version": 1, "projectFolder": projectFolder, "documentHash": hex.EncodeToString(hash[:]),
		"sourceHash": manifest.SourceHash, "settings": media.Settings, "plugins": available,
	})
	if err != nil || os.WriteFile(filepath.Join(folder, "job.json"), input, 0600) != nil {
		return fail("render_job_write_failed")
	}

	workerInfo, err := os.Stat(s.renderer.executable)
	if err != nil || !os.SameFile(workerInfo, s.renderer.executableInfo) || workerInfo.Size() != s.renderer.executableInfo.Size() ||
		!workerInfo.ModTime().Equal(s.renderer.executableInfo.ModTime()) {
		return fail("render_worker_changed")
	}

	run, stop := context.WithTimeout(ctx, time.Duration(media.Settings.TimeoutSeconds)*time.Second)
	command := gitCommand(run, s.renderer.executable, folder, "--job", folder)
	command.Env = []string{"LC_ALL=C", "PATH=/usr/bin:/bin", "HOME=" + folder, "TMPDIR=" + folder}
	err = command.Run()
	stop()
	if err != nil {
		return fail("render_worker_failed")
	}

	result, metadata, err := verifiedReviewWAV(folder, manifest.SourceHash, media.Settings)
	if err != nil {
		return fail("render_output_invalid")
	}
	wav, err := os.Open(filepath.Join(folder, "mix.wav"))
	if err != nil {
		return fail("render_output_unavailable")
	}
	defer wav.Close()

	key := reviewMediaKey(projectID, media.ReviewID, metadata.SHA256)
	if err := s.blobs.Put(ctx, key, metadata, wav); err != nil {
		return fail("render_upload_failed")
	}

	return renderOutcome{state: "ready", manifest: result, digest: metadata.SHA256, size: metadata.Size}
}

func (renderer *reviewRenderer) pluginsForDocument(document []byte) ([]renderPlugin, []string, error) {
	var model struct {
		Plugins map[string]struct {
			Identifier string `json:"identifier"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(document, &model); err != nil {
		return nil, nil, err
	}

	selected := make([]renderPlugin, 0)
	var missing []string
	seen := make(map[string]bool)
	for _, plugin := range model.Plugins {
		identity := plugin.Identifier
		if seen[identity] {
			continue
		}
		seen[identity] = true

		if available, found := renderer.plugins[identity]; found {
			selected = append(selected, available)
		} else {
			missing = append(missing, identity)
		}
	}

	sort.Strings(missing)
	sort.Slice(selected, func(i, j int) bool { return selected[i].Identity < selected[j].Identity })
	return selected, missing, nil
}

func (s *Server) stageRenderProject(ctx context.Context, view gitView, projectID, commit, folder string, document []byte, manifest versionManifest) error {
	if err := os.Mkdir(folder, 0700); err != nil {
		return err
	}
	for name, digest := range manifest.Media {
		relative := filepath.FromSlash(name)
		if !filepath.IsLocal(relative) || !lfsOID.MatchString(digest) {
			return errors.New("invalid media path")
		}
		destination := filepath.Join(folder, relative)
		if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
			return err
		}

		pointer, err := view.read(ctx, 256, "cat-file", "blob", commit+":"+name)
		if err != nil {
			return err
		}
		if len(pointer) == 0 && digest == emptyBlobHash && strings.HasPrefix(name, "plugin-states/") {
			if err := os.WriteFile(destination, nil, 0600); err != nil {
				return err
			}
			continue
		}
		object, err := parseLFSPointer(pointer, digest)
		if err != nil {
			return err
		}
		if err := s.downloadRenderAsset(ctx, projectID, object, destination); err != nil {
			return err
		}
	}

	return os.WriteFile(filepath.Join(folder, "project.json"), document, 0600)
}

func (s *Server) downloadRenderAsset(ctx context.Context, projectID string, object lfsObject, destination string) error {
	stream, metadata, err := s.blobs.Open(ctx, lfsKey(projectID, object.OID))
	if err != nil {
		return err
	}
	defer stream.Close()
	if metadata.Size != object.Size || metadata.SHA256 != object.OID {
		return errors.New("render asset metadata mismatch")
	}

	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}

	digest := sha256.New()
	count, err := io.Copy(io.MultiWriter(file, digest), io.LimitReader(stream, object.Size+1))
	if err := errors.Join(err, file.Close()); err != nil {
		return err
	}
	if count != object.Size || hex.EncodeToString(digest.Sum(nil)) != object.OID {
		return errors.New("render asset checksum mismatch")
	}

	return nil
}

func readSmallFile(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, errors.New("file exceeds read limit")
	}
	return data, nil
}

func verifiedReviewWAV(folder, sourceHash string, settings reviewRenderSettings) (json.RawMessage, BlobMetadata, error) {
	raw, err := readSmallFile(filepath.Join(folder, "render.json"), 4<<20)
	if err != nil {
		return nil, BlobMetadata{}, err
	}
	var report struct {
		Version     int                  `json:"version"`
		Complete    bool                 `json:"complete"`
		SourceHash  string               `json:"sourceHash"`
		Settings    reviewRenderSettings `json:"settings"`
		Environment json.RawMessage      `json:"environment"`
		Outputs     []struct {
			File   string `json:"file"`
			SHA256 string `json:"sha256"`
			Bytes  int64  `json:"bytes"`
			Frames int64  `json:"frames"`
		} `json:"outputs"`
	}
	if err := json.Unmarshal(raw, &report); err != nil || report.Version != 1 || !report.Complete ||
		report.SourceHash != sourceHash || !reflect.DeepEqual(report.Settings, settings) || len(report.Environment) == 0 ||
		len(report.Outputs) != 1 || report.Outputs[0].File != "mix.wav" || report.Outputs[0].Frames <= 0 {
		return nil, BlobMetadata{}, errors.New("invalid review render manifest")
	}

	output := report.Outputs[0]
	path := filepath.Join(folder, "mix.wav")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 44 || info.Size() > lfsObjectLimit || info.Size() != output.Bytes ||
		!lfsOID.MatchString(output.SHA256) {
		return nil, BlobMetadata{}, errors.New("invalid review WAV size")
	}

	wav, err := os.Open(path)
	if err != nil {
		return nil, BlobMetadata{}, err
	}
	defer wav.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, wav); err != nil {
		return nil, BlobMetadata{}, err
	}
	if hex.EncodeToString(digest.Sum(nil)) != output.SHA256 {
		return nil, BlobMetadata{}, errors.New("review WAV checksum mismatch")
	}

	return raw, BlobMetadata{Size: output.Bytes, SHA256: output.SHA256}, nil
}
