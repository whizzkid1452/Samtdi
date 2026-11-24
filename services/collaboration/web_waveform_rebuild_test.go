package collaboration

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os/exec"
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
	store := func(data []byte) webArtifact {
		t.Helper()
		digest := sha256.Sum256(data)
		hash := hex.EncodeToString(digest[:])
		artifact := webArtifact{key: "review-media/" + hash, size: int64(len(data)), digest: hash}
		if err := blobs.Put(ctx, artifact.key, BlobMetadata{Size: artifact.size, SHA256: hash}, bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
		return artifact
	}
	playback := store(audio)
	legacy := store([]byte(`{"duration_ms":1000,"peaks":[0.5]}`))
	_, err = pool.Exec(ctx, `UPDATE web_media_versions SET duration_ms=1000,playback_key=$2,playback_bytes=$3,playback_hash=$4,
 peaks_key=$5,peaks_bytes=$6,peaks_hash=$7 WHERE id=$1`, team.version, playback.key, playback.size, playback.digest,
		legacy.key, legacy.size, legacy.digest)
	if err != nil {
		t.Fatal(err)
	}

	for range 2 {
		if err := rebuildWebWaveforms(ctx, pool, blobs); err != nil {
			t.Fatal(err)
		}
	}
	if writes() != 3 {
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
}
