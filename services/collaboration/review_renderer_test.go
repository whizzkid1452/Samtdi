package collaboration

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifiedReviewWAVManifestVersions(t *testing.T) {
	const wav = "RIFF\x26\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x80\xbb\x00\x00\x00\x77\x01\x00\x02\x00\x10\x00data\x02\x00\x00\x00\x00\x00"
	digest := sha256.Sum256([]byte(wav))
	wavHash := hex.EncodeToString(digest[:])
	sourceHash := strings.Repeat("a", 64)
	documentHash := strings.Repeat("b", 64)
	settings := reviewRenderSettings{EndSeconds: 1.0 / 48000, SampleRateHz: 48000, BitDepth: 16,
		Channels: 1, BlockSize: 256, TimeoutSeconds: 480, Stems: []string{}}

	for _, test := range []struct {
		name         string
		version      int
		documentHash string
		wantOK       bool
	}{
		{name: "v1 without document hash", version: 1, wantOK: true},
		{name: "v2 with matching document hash", version: 2, documentHash: documentHash, wantOK: true},
		{name: "v2 without document hash", version: 2},
		{name: "v2 with canonical hash instead of document hash", version: 2, documentHash: sourceHash},
		{name: "unknown version", version: 3, documentHash: documentHash},
	} {
		t.Run(test.name, func(t *testing.T) {
			folder := t.TempDir()
			manifest := map[string]any{"version": test.version, "complete": true, "sourceHash": sourceHash,
				"settings": settings, "environment": map[string]string{"os": "test"},
				"outputs": []map[string]any{{"file": "mix.wav", "sha256": wavHash, "bytes": len(wav), "frames": 1}}}
			if test.documentHash != "" {
				manifest["sourceDocumentHash"] = test.documentHash
			}

			data, err := json.Marshal(manifest)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(folder, "render.json"), data, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(folder, "mix.wav"), []byte(wav), 0600); err != nil {
				t.Fatal(err)
			}

			_, metadata, err := verifiedReviewWAV(folder, sourceHash, documentHash, settings)
			if (err == nil) != test.wantOK {
				t.Fatalf("verifiedReviewWAV returned %v, want success %t", err, test.wantOK)
			}
			if test.wantOK && (metadata.SHA256 != wavHash || metadata.Size != int64(len(wav))) {
				t.Fatalf("unexpected WAV metadata: %+v", metadata)
			}
		})
	}
}
