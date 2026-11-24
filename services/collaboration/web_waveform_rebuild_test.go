package collaboration

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestRebuildWebWaveformsKeepsReadyVersionAndPlayback(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("FFmpeg is required to verify waveform rebuilding")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("FFprobe is required to verify waveform rebuilding")
	}

	team := newWebTeam(t)
	pool := team.server.pool
	ctx := t.Context()
	audio, err := exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
		"aevalsrc=0.75*sin(2*PI*330*t)|0.25*sin(2*PI*550*t):s=10000:d=1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1").Output()
	if err != nil {
		t.Fatal(err)
	}
	blobs, writes := testObjectStore(t)
	store := func(filename string, data []byte) webArtifact {
		t.Helper()
		digest := sha256.Sum256(data)
		hash := hex.EncodeToString(digest[:])
		prefix := "web/versions/" + team.project + "/" + team.version + "/92e975f7-496c-412b-9cfe-6033a93184e2/"
		artifact := webArtifact{key: prefix + filename, size: int64(len(data)), digest: hash}
		if err := blobs.Put(ctx, artifact.key, BlobMetadata{Size: artifact.size, SHA256: hash}, bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
		return artifact
	}
	original := store("source.wav", audio)
	playback := store("playback.wav", audio)
	legacy := store("peaks.json", []byte(`{"duration_ms":1000,"peaks":[0.5]}`))
	_, err = pool.Exec(ctx, `UPDATE web_media_versions SET duration_ms=1000,playback_key=$2,playback_bytes=$3,playback_hash=$4,
 peaks_key=$5,peaks_bytes=$6,peaks_hash=$7,original_key=$8,original_bytes=$9,original_hash=$10 WHERE id=$1`, team.version, playback.key, playback.size, playback.digest,
		legacy.key, legacy.size, legacy.digest, original.key, original.size, original.digest)
	if err != nil {
		t.Fatal(err)
	}

	for range 2 {
		if err := rebuildWebWaveforms(ctx, pool, blobs); err != nil {
			t.Fatal(err)
		}
	}
	if writes() != 4 {
		t.Fatalf("expected one new waveform upload, got %d total uploads", writes())
	}

	var state, key, retainedPlayback string
	if err := pool.QueryRow(ctx, "SELECT state,peaks_key,playback_key FROM web_media_versions WHERE id=$1", team.version).
		Scan(&state, &key, &retainedPlayback); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || key == legacy.key || retainedPlayback != playback.key {
		t.Fatalf("version state, waveform or playback is inconsistent: %s %s %s", state, key, retainedPlayback)
	}
	body, _, err := blobs.Open(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := io.ReadAll(body)
	body.Close()
	if err != nil {
		t.Fatal(err)
	}
	var waveform webWaveform
	if err := json.Unmarshal(encoded, &waveform); err != nil || len(waveform.ChannelPeaks) != 2 {
		t.Fatalf("expected two stored channels, got %d: %v", len(waveform.ChannelPeaks), err)
	}

	t.Run("restore_and_play", func(t *testing.T) {
		source := webRenderSource{SnapshotID: original.digest, AudioSHA256: original.digest}
		if _, err := pool.Exec(t.Context(), "UPDATE web_uploads SET render_source=$2 WHERE id=$1", team.version, source); err != nil {
			t.Fatal(err)
		}

		root := filepath.Join(t.TempDir(), "snapshot")
		if err := (snapshotState{pool: pool, blobs: blobs}).snapshot(t.Context(), root); err != nil {
			t.Fatal(err)
		}
		targetPool := integrationPool(t)
		targetBlobs, _ := testObjectStore(t)
		if err := (snapshotState{pool: targetPool, blobs: targetBlobs}).restore(t.Context(), root); err != nil {
			t.Fatal(err)
		}

		listener := httptest.NewUnstartedServer(nil)
		provider, _ := testProvider(t)
		restored, err := NewServer(t.Context(), targetPool, Config{
			Origin: "http://" + listener.Listener.Addr().String(), Issuer: provider.URL,
			ClientID: "test-client", ClientSecret: "test-secret", AllowLoopbackHTTP: true,
		})
		if err != nil {
			listener.Close()
			t.Fatal(err)
		}
		restored.blobs = targetBlobs
		listener.Config.Handler = restored
		listener.Start()
		t.Cleanup(listener.Close)
		url := listener.URL + "/v1/projects/" + team.project + "/versions/" + team.version
		response(t, listener.Client(), "GET", url, team.tokens["reviewer"], "", nil, 401, nil)
		token, err := createSession(t.Context(), targetPool, team.ids["reviewer"], "native")
		if err != nil {
			t.Fatal(err)
		}

		var version webVersion
		response(t, listener.Client(), "GET", url, token, "", nil, 200, &version)
		if version.Source == nil || version.Source.SnapshotID != source.SnapshotID {
			t.Fatalf("render source missing after restore: %+v", version.Source)
		}
		var restoredWaveform webWaveform
		response(t, listener.Client(), "GET", url+"/files/peaks", token, "", nil, 200, &restoredWaveform)
		if len(restoredWaveform.ChannelPeaks) != 2 {
			t.Fatalf("expected two restored channels, got %d", len(restoredWaveform.ChannelPeaks))
		}

		request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url+"/files/playback", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Range", "bytes=0-11")
		play, err := listener.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer play.Body.Close()

		prefix, err := io.ReadAll(play.Body)
		if err != nil || play.StatusCode != http.StatusPartialContent || !bytes.Equal(prefix, audio[:12]) {
			t.Fatalf("restored WAV range: HTTP %d, %q, %v", play.StatusCode, prefix, err)
		}
	})
}
