package collaboration

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"strings"
	"testing"
)

func TestSupabaseS3Endpoint(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want bool
	}{
		{"https://example.storage.supabase.co/storage/v1/s3", true},
		{"http://example.storage.supabase.co/storage/v1/s3", false},
		{"https://example.storage.supabase.co.evil.example/storage/v1/s3", false},
		{"https://example.storage.supabase.co:444/storage/v1/s3", false},
		{"https://example.storage.supabase.co/other", false},
	} {
		parsed, err := url.Parse(tc.raw)
		if err != nil || isSupabaseS3Endpoint(parsed) != tc.want {
			t.Errorf("unexpected endpoint classification for %s", tc.raw)
		}
	}
	if (&s3Store{supabase: true}).objectLimit() != 45_000_000 || (&s3Store{}).objectLimit() != webUploadLimit {
		t.Fatal("unexpected size limit")
	}
}

func TestVerifyBlobChecksum(t *testing.T) {
	digest := sha256.Sum256([]byte("sound"))
	want := BlobMetadata{Size: 5, SHA256: hex.EncodeToString(digest[:])}
	if err := verifyBlobChecksum(strings.NewReader("sound"), want); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"audio", "sounds", "soun"} {
		if err := verifyBlobChecksum(strings.NewReader(value), want); err == nil {
			t.Fatalf("accepted invalid bytes: %q", value)
		}
	}
}
