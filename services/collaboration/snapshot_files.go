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
	"slices"
	"strings"
)

func snapshotRefs(ctx context.Context, git *GitRepositories, folder string) (string, error) {
	output, err := git.run(ctx, folder, "for-each-ref", "--format=%(refname) %(objectname)")
	return string(output), err
}

func objectPath(object snapshotObject) string {
	return filepath.Join("objects", filepath.FromSlash(object.Key))
}

func validSnapshotObject(object snapshotObject) bool {
	if !lfsOID.MatchString(object.SHA256) || object.Bytes < 0 || object.Bytes > lfsObjectLimit {
		return false
	}
	parts := strings.Split(object.Key, "/")
	if parts[0] == "web" {
		if object.Bytes == 0 || object.Bytes > webUploadLimit {
			return false
		}
		if len(parts) == 4 && parts[1] == "incoming" {
			return uuidPattern.MatchString(parts[2]) && uuidPattern.MatchString(parts[3])
		}
		if len(parts) != 6 || parts[1] != "versions" || !uuidPattern.MatchString(parts[2]) ||
			!uuidPattern.MatchString(parts[3]) || !uuidPattern.MatchString(parts[4]) {
			return false
		}
		switch parts[5] {
		case "source.wav", "source.mp3", "playback.wav", "peaks.json":
			return true
		default:
			return false
		}
	}
	if len(parts) != 4 || !uuidPattern.MatchString(parts[1]) || parts[3] != object.SHA256 {
		return false
	}

	return (parts[0] == "lfs" && parts[2] == object.SHA256[:2]) ||
		(parts[0] == "review-media" && uuidPattern.MatchString(parts[2]) && object.Bytes > 44)
}

func equalObjects(a, b []snapshotObject) bool { return slices.Equal(a, b) }

func writeSnapshotFile(root, name string, write func(io.Writer) error) (snapshotFile, error) {
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return snapshotFile{}, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return snapshotFile{}, err
	}

	digest := sha256.New()
	writeErr := write(io.MultiWriter(file, digest))
	syncErr := file.Sync()
	info, statErr := file.Stat()
	if err := errors.Join(writeErr, syncErr, statErr, file.Close()); err != nil {
		return snapshotFile{}, err
	}

	return snapshotFile{Path: name, Bytes: info.Size(), SHA256: hex.EncodeToString(digest.Sum(nil))}, nil
}

func inspectSnapshotFile(root, name string) (snapshotFile, error) {
	if !filepath.IsLocal(name) {
		return snapshotFile{}, errors.New("invalid snapshot path")
	}
	protected, err := os.OpenRoot(root)
	if err != nil {
		return snapshotFile{}, err
	}
	defer protected.Close()
	file, err := protected.Open(name)
	if err != nil {
		return snapshotFile{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return snapshotFile{}, errors.New("invalid snapshot file")
	}

	digest := sha256.New()
	count, err := io.Copy(digest, file)
	if err != nil {
		return snapshotFile{}, err
	}

	return snapshotFile{Path: name, Bytes: count, SHA256: hex.EncodeToString(digest.Sum(nil))}, nil
}

func readSnapshot(root string) (snapshotManifest, error) {
	data, err := readSmallFile(filepath.Join(root, "manifest.json"), snapshotManifestLimit)
	if err != nil {
		return snapshotManifest{}, err
	}
	var manifest snapshotManifest
	if err := json.Unmarshal(data, &manifest); err != nil || (manifest.Version != 1 && manifest.Version != 2 && manifest.Version != 3) || len(manifest.Tables) != len(tablesForSnapshot(manifest.Version)) {
		return snapshotManifest{}, errors.New("invalid collaboration snapshot manifest")
	}

	verify := func(expected snapshotFile, name string) error {
		if expected.Path != name || !lfsOID.MatchString(expected.SHA256) || expected.Bytes < 0 {
			return errors.New("invalid snapshot file record")
		}
		actual, err := inspectSnapshotFile(root, name)
		if err != nil || actual != expected {
			return errors.New("snapshot file checksum mismatch")
		}
		return nil
	}
	for i, table := range tablesForSnapshot(manifest.Version) {
		if err := verify(manifest.Tables[i], filepath.Join("db", table+".copy")); err != nil {
			return snapshotManifest{}, err
		}
	}
	for _, repository := range manifest.Repositories {
		if !uuidPattern.MatchString(repository.ProjectID) || (repository.Refs == "") != (repository.Bundle == nil) {
			return snapshotManifest{}, errors.New("invalid snapshot repository record")
		}
		if repository.Bundle != nil {
			if err := verify(*repository.Bundle, filepath.Join("git", repository.ProjectID+".bundle")); err != nil {
				return snapshotManifest{}, err
			}
		}
	}
	for _, object := range manifest.Objects {
		if !validSnapshotObject(object) {
			return snapshotManifest{}, errors.New("invalid snapshot object record")
		}
		name := objectPath(object)
		if err := verify(snapshotFile{Path: name, Bytes: object.Bytes, SHA256: object.SHA256}, name); err != nil {
			return snapshotManifest{}, err
		}
	}

	return manifest, nil
}
