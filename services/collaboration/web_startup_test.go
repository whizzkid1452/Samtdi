package collaboration

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWebStartsWithStorageAndWithoutGit(t *testing.T) {
	pool := integrationPool(t)
	provider, _ := testProvider(t)
	settings := Config{
		Origin: "http://127.0.0.1:3000", Issuer: provider.URL,
		ClientID: "test-client", ClientSecret: "test-secret", AllowLoopbackHTTP: true,
		S3: S3Config{Bucket: "samtdi", Region: "us-east-1", Endpoint: "http://127.0.0.1:9000"},
	}

	handler, err := NewServer(t.Context(), pool, settings)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handler.Close() })

	for path, want := range map[string]int{"/healthz": http.StatusOK, "/git/anything/info/refs": http.StatusNotFound} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != want {
			t.Errorf("%s: want %d, got %d", path, want, recorder.Code)
		}
	}
}
