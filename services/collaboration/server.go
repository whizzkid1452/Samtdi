package collaboration

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"
)

type Config struct {
	Origin                string
	Issuer                string
	ClientID              string
	ClientSecret          string
	BootstrapEmail        string
	AllowLoopbackHTTP     bool
	ProjectToolPath       string
	ReceiveHookExecutable string
	Git                   GitConfig
	S3                    S3Config
	Renderer              RendererConfig
}

type Server struct {
	metrics        serviceMetrics
	renderer       *reviewRenderer
	pool           *pgxpool.Pool
	config         Config
	origin         string
	secureCookies  bool
	oauth          oauth2.Config
	verifier       *oidc.IDTokenVerifier
	providerClient *http.Client
	mux            *http.ServeMux
	projectTool    ProjectTool
	git            *GitRepositories
	blobs          BlobStore
	lfsSlots       chan struct{}
	receive        *receiveGate
}

func NewServer(ctx context.Context, pool *pgxpool.Pool, config Config) (*Server, error) {
	origin, err := url.Parse(config.Origin)
	if err != nil || !validEndpoint(origin, config.AllowLoopbackHTTP) || origin.Path != "" || origin.ForceQuery {
		return nil, errors.New("origin must be an HTTPS origin")
	}

	issuer, err := url.Parse(config.Issuer)
	if err != nil || !validEndpoint(issuer, config.AllowLoopbackHTTP) || config.ClientID == "" || config.ClientSecret == "" {
		return nil, errors.New("valid OIDC issuer, client ID and client secret are required")
	}

	if config.BootstrapEmail != "" {
		config.BootstrapEmail, err = verifiedEmail(config.BootstrapEmail)
		if err != nil {
			return nil, errors.New("invalid bootstrap email")
		}
	}

	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	provider, err := oidc.NewProvider(oidc.ClientContext(ctx, client), config.Issuer)
	if err != nil {
		return nil, errors.New("OIDC discovery failed")
	}

	var discovery struct {
		JWKSURL string `json:"jwks_uri"`
	}
	if err := provider.Claims(&discovery); err != nil {
		return nil, errors.New("invalid OIDC discovery response")
	}

	endpoints := provider.Endpoint()
	for _, raw := range []string{endpoints.AuthURL, endpoints.TokenURL, discovery.JWKSURL} {
		endpoint, err := url.Parse(raw)
		if err != nil || !validEndpoint(endpoint, config.AllowLoopbackHTTP) {
			return nil, errors.New("OIDC provider returned an invalid endpoint")
		}
	}

	server := &Server{
		pool: pool, config: config, origin: origin.String(), secureCookies: origin.Scheme == "https",
		providerClient: client, verifier: provider.Verifier(&oidc.Config{ClientID: config.ClientID}),
		oauth: oauth2.Config{
			ClientID: config.ClientID, ClientSecret: config.ClientSecret, Endpoint: endpoints,
			RedirectURL: origin.String() + "/v1/auth/callback", Scopes: []string{oidc.ScopeOpenID, "email"},
		},
		mux: http.NewServeMux(),
	}
	if config.ProjectToolPath != "" {
		server.projectTool, err = NewProjectTool(config.ProjectToolPath)
		if err != nil {
			return nil, err
		}
	}
	if config.Git.Root != "" || config.Git.Executable != "" {
		server.git, err = NewGitRepositories(ctx, config.Git)
		if err != nil {
			return nil, err
		}
	}
	if config.S3 != (S3Config{}) {
		server.blobs, err = newS3Store(ctx, config.S3, config.AllowLoopbackHTTP)
		if err != nil {
			return nil, err
		}
	}
	if server.git != nil {
		if server.blobs == nil || server.projectTool.executable == "" {
			return nil, errors.New("Git receive validation requires S3 and the headless project tool")
		}
		server.receive, err = startReceiveGate(config.ReceiveHookExecutable, int(pool.Config().MaxConns)/2, server.validateReceive)
		if err != nil {
			return nil, errors.New("could not initialize Git receive validation")
		}
	}
	if config.Renderer != (RendererConfig{}) {
		if server.receive == nil {
			return nil, errors.New("review rendering requires validated Git and object storage")
		}
		server.renderer, err = newReviewRenderer(config.Renderer)
		if err != nil {
			_ = server.Close()
			return nil, err
		}
	}
	server.routes()
	return server, nil
}

func (s *Server) Close() error {
	if s.receive == nil {
		return nil
	}

	return s.receive.close()
}

func validEndpoint(endpoint *url.URL, loopbackHTTP bool) bool {
	if endpoint.Hostname() == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return false
	}

	return endpoint.Scheme == "https" ||
		(loopbackHTTP && endpoint.Scheme == "http" && endpoint.Hostname() == "127.0.0.1")
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Robots-Tag", "noindex")
	s.serveObserved(w, r)
}

func (s *Server) routes() {
	if s.receive != nil {
		s.reviewRoutes()
		s.reviewMediaRoutes()
		s.reviewWebRoutes()
	}

	if s.git != nil {
		s.lfsSlots = make(chan struct{}, 4)
		s.mux.HandleFunc("/git/{repository}/{operation...}", s.withGitSession(s.gitHTTP))
	}

	s.mux.HandleFunc("GET /v1/operations", s.withSession(s.operations))
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := s.pool.Ping(r.Context()); err != nil {
			problem(w, http.StatusServiceUnavailable, "database_unavailable")
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	s.mux.HandleFunc("GET /v1/auth/login", s.beginLogin)
	s.mux.HandleFunc("GET /v1/auth/callback", s.completeLogin)
	s.mux.HandleFunc("GET /v1/native/authorize", s.beginLogin)
	s.mux.HandleFunc("POST /v1/native/token", s.exchangeNativeCode)
	s.mux.HandleFunc("GET /v1/me", s.withSession(s.me))
	s.mux.HandleFunc("POST /v1/auth/logout", s.withSession(s.logout))
	s.mux.HandleFunc("GET /v1/projects", s.withSession(s.listProjects))
	s.mux.HandleFunc("POST /v1/projects", s.withSession(s.createProject))
	s.mux.HandleFunc("GET /v1/projects/{project}/members", s.withSession(s.listMembers))
	s.mux.HandleFunc("PATCH /v1/projects/{project}/members/{account}", s.withSession(s.changeMember))
	s.mux.HandleFunc("DELETE /v1/projects/{project}/members/{account}", s.withSession(s.changeMember))
	s.mux.HandleFunc("POST /v1/projects/{project}/invitations", s.withSession(s.invite))
	s.mux.HandleFunc("DELETE /v1/projects/{project}/invitations/{invite}", s.withSession(s.revokeInvite))
}

type failure struct {
	Error string `json:"error"`
}

func problem(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, failure{Error: code})
}

func internal(w http.ResponseWriter, operation string, err error) {
	reportOperation(operation, err)
	problem(w, http.StatusInternalServerError, "internal_error")
}

func reportOperation(operation string, err error) {
	slog.Error("collaboration operation failed", "operation", operation, "type", errorType(err))
}

func errorType(err error) string {
	var typed interface{ SQLState() string }
	if errors.As(err, &typed) {
		return typed.SQLState()
	}

	return "operation_failed"
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func readJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil || decoder.Decode(new(any)) != io.EOF {
		problem(w, http.StatusBadRequest, "invalid_json")
		return false
	}

	return true
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func verifiedEmail(raw string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	parsed, err := mail.ParseAddress(normalized)
	if err != nil || parsed.Address != normalized || len(normalized) > 254 {
		return "", errors.New("invalid email")
	}

	return normalized, nil
}
