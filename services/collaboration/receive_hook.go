package collaboration

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	receiveInputLimit        = 64 << 10
	receiveValidationTimeout = 2 * time.Minute
)

type receiveScope struct {
	ctx        context.Context
	projectID  string
	repository string
	songID     string
	role       Role
	validated  chan string
}

type receiveGate struct {
	folder   string
	socket   string
	server   *http.Server
	slots    chan struct{}
	mutex    sync.Mutex
	requests map[string]receiveScope
	validate func(context.Context, receiveScope, string, []byte) (string, error)
}

func startReceiveGate(executable string, concurrency int, validate func(context.Context, receiveScope, string, []byte) (string, error)) (*receiveGate, error) {
	if !filepath.IsAbs(executable) || concurrency < 1 {
		return nil, errors.New("receive validation needs the service executable and at least two database connections")
	}

	folder, err := os.MkdirTemp("/tmp", "ayotbi-gate-")
	if err != nil {
		return nil, err
	}

	gate := &receiveGate{
		folder: folder, socket: filepath.Join(folder, "hook.sock"), validate: validate,
		requests: make(map[string]receiveScope), slots: make(chan struct{}, min(concurrency, 4)),
	}
	if err := installReceiveHook(executable, filepath.Join(folder, "pre-receive")); err != nil {
		os.RemoveAll(folder)
		return nil, err
	}
	listener, err := net.Listen("unix", gate.socket)
	if err != nil {
		os.RemoveAll(folder)
		return nil, err
	}

	gate.server = &http.Server{Handler: http.HandlerFunc(gate.check), ReadHeaderTimeout: 3 * time.Second, MaxHeaderBytes: 8 << 10}
	go func() { _ = gate.server.Serve(listener) }()
	return gate, nil
}

func installReceiveHook(executable, target string) error {
	source, err := os.Open(executable)
	if err != nil {
		return err
	}
	defer source.Close()

	hook, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0500)
	if err != nil {
		return err
	}

	_, err = io.Copy(hook, source)
	return errors.Join(err, hook.Close())
}

func (gate *receiveGate) close() error {
	return errors.Join(gate.server.Close(), os.RemoveAll(gate.folder))
}

func (gate *receiveGate) issue(scope receiveScope) (string, []string, error) {
	info, err := os.Lstat(filepath.Join(gate.folder, "pre-receive"))
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0100 == 0 {
		return "", nil, errors.New("receive hook is unavailable")
	}

	token := randomToken()
	gate.mutex.Lock()
	gate.requests[token] = scope
	gate.mutex.Unlock()

	return token, []string{
		"GIT_CONFIG_COUNT=2", "GIT_CONFIG_KEY_1=core.hooksPath", "GIT_CONFIG_VALUE_1=" + gate.folder,
		"AYOTBI_HOOK_SOCKET=" + gate.socket, "AYOTBI_HOOK_TOKEN=" + token,
	}, nil
}

func (gate *receiveGate) consume(token string) (receiveScope, bool) {
	gate.mutex.Lock()
	defer gate.mutex.Unlock()
	scope, ok := gate.requests[token]
	delete(gate.requests, token)
	return scope, ok
}

func (gate *receiveGate) check(w http.ResponseWriter, r *http.Request) {
	scope, ok := gate.consume(r.Header.Get("X-Ayotbi-Hook"))
	if !ok || r.Method != http.MethodPost || r.URL.Path != "/validate" {
		http.Error(w, "validation_scope_missing", http.StatusForbidden)
		return
	}

	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, receiveInputLimit))
	if err != nil {
		http.Error(w, "invalid_receive_request", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(scope.ctx, receiveValidationTimeout)
	defer cancel()
	stop := context.AfterFunc(r.Context(), cancel)
	defer stop()

	song, err := gate.validate(ctx, scope, r.Header.Get("X-Ayotbi-Quarantine"), raw)
	if err != nil {
		var rejected receiveRejection
		if errors.As(err, &rejected) {
			http.Error(w, string(rejected), http.StatusUnprocessableEntity)
		} else {
			http.Error(w, "receive_validation_failed", http.StatusServiceUnavailable)
		}
		return
	}

	scope.validated <- song
	w.WriteHeader(http.StatusNoContent)
}

func RunReceiveHook(ctx context.Context, input io.Reader, output io.Writer) error {
	socket := os.Getenv("AYOTBI_HOOK_SOCKET")
	token := os.Getenv("AYOTBI_HOOK_TOKEN")
	if socket == "" || !tokenPattern.MatchString(token) {
		return errors.New("validation_scope_missing")
	}

	body, err := io.ReadAll(io.LimitReader(input, receiveInputLimit+1))
	if err != nil || len(body) > receiveInputLimit {
		return errors.New("invalid_receive_request")
	}

	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: receiveValidationTimeout + 5*time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost/validate", bytes.NewReader(body))
	if err != nil {
		return errors.New("invalid_receive_request")
	}

	request.Header.Set("X-Ayotbi-Hook", token)
	request.Header.Set("X-Ayotbi-Quarantine", os.Getenv("GIT_QUARANTINE_PATH"))
	response, err := client.Do(request)
	if err != nil {
		return errors.New("receive_validation_unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		reason, _ := io.ReadAll(io.LimitReader(response.Body, 256))
		_, _ = fmt.Fprintf(output, "Ayotbi: %s", reason)
		return errors.New("receive_rejected")
	}

	return nil
}
