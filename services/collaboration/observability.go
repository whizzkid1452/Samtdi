package collaboration

import (
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

type routeCounters struct {
	Requests      uint64 `json:"requests"`
	ClientErrors  uint64 `json:"client_errors"`
	ServerErrors  uint64 `json:"server_errors"`
	ResponseBytes uint64 `json:"response_bytes"`
	TotalMillis   int64  `json:"total_milliseconds"`
}

type serviceMetrics struct {
	mu     sync.Mutex
	routes map[string]routeCounters
}

func (metrics *serviceMetrics) record(route string, status int, elapsed time.Duration, bytes uint64) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()

	if metrics.routes == nil {
		metrics.routes = make(map[string]routeCounters)
	}
	counts := metrics.routes[route]
	counts.Requests++
	counts.ResponseBytes += bytes
	counts.TotalMillis += elapsed.Milliseconds()
	switch {
	case status >= 500:
		counts.ServerErrors++
	case status >= 400:
		counts.ClientErrors++
	}
	metrics.routes[route] = counts
}

func (metrics *serviceMetrics) snapshot() map[string]routeCounters {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()

	copy := make(map[string]routeCounters, len(metrics.routes))
	for route, counters := range metrics.routes {
		copy[route] = counters
	}
	return copy
}

type responseStatus struct {
	http.ResponseWriter
	status int
	bytes  uint64
}

func (tracked *responseStatus) Unwrap() http.ResponseWriter { return tracked.ResponseWriter }

func (tracked *responseStatus) WriteHeader(code int) {
	if tracked.status == 0 && code >= 200 {
		tracked.status = code
	}
	tracked.ResponseWriter.WriteHeader(code)
}

func (tracked *responseStatus) Write(raw []byte) (int, error) {
	if tracked.status == 0 {
		tracked.status = http.StatusOK
	}
	n, err := tracked.ResponseWriter.Write(raw)
	tracked.bytes += uint64(n)
	return n, err
}

func (s *Server) serveObserved(w http.ResponseWriter, r *http.Request) {
	requestID := randomToken()
	w.Header().Set("X-Request-ID", requestID)
	observed := &responseStatus{ResponseWriter: w}
	started := time.Now()
	s.mux.ServeHTTP(observed, r)

	status := observed.status
	if status == 0 {
		status = http.StatusOK
	}
	elapsed := time.Since(started)
	route := r.Pattern
	if route == "" {
		route = "unmatched"
	}
	s.metrics.record(route, status, elapsed, observed.bytes)
	if status >= 400 {
		slog.Info("collaboration response", "request_id", requestID, "route", route, "status", status, "duration_ms", elapsed.Milliseconds())
	}
}

func (s *Server) operations(w http.ResponseWriter, r *http.Request, session Session) {
	ctx := r.Context()
	var operator bool
	if err := s.pool.QueryRow(ctx, `SELECT operator FROM accounts WHERE id = $1`, session.AccountID).Scan(&operator); err != nil {
		internal(w, "read_operator", err)
		return
	}
	if !operator {
		problem(w, http.StatusForbidden, "operator_required")
		return
	}

	var lfsObjects, lfsBytes, reviewVersions int64
	if err := s.pool.QueryRow(ctx, `SELECT count(*),coalesce(sum(size),0)::bigint FROM lfs_objects`).Scan(&lfsObjects, &lfsBytes); err != nil {
		internal(w, "lfs_counters", err)
		return
	}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM reviews`).Scan(&reviewVersions); err != nil {
		internal(w, "review_counters", err)
		return
	}

	rows, err := s.pool.Query(ctx, `SELECT state,count(*) FROM review_media_versions GROUP BY state`)
	if err != nil {
		internal(w, "render_counters", err)
		return
	}
	type renderCount struct {
		State string `json:"state"`
		Count int64  `json:"count"`
	}
	renders, err := pgx.CollectRows(rows, pgx.RowToStructByName[renderCount])
	if err != nil {
		internal(w, "read_render_counters", err)
		return
	}

	mediaRows, err := s.pool.Query(ctx, `SELECT state,count(*) FROM web_media_versions GROUP BY state`)
	if err != nil {
		internal(w, "web_media_counters", err)
		return
	}
	mediaStates, err := pgx.CollectRows(mediaRows, pgx.RowToStructByName[renderCount])
	if err != nil {
		internal(w, "read_web_media_counters", err)
		return
	}
	var mediaBytes, waitingMillis int64
	err = s.pool.QueryRow(ctx, `SELECT
 COALESCE((SELECT sum(original_bytes+playback_bytes+peaks_bytes)::bigint FROM web_media_versions WHERE state='ready'),0),
 COALESCE((SELECT (EXTRACT(EPOCH FROM (now()-min(v.created_at)))*1000)::bigint
 FROM web_media_jobs j JOIN web_media_versions v ON v.id=j.version_id WHERE j.finished_at IS NULL),0)`).
		Scan(&mediaBytes, &waitingMillis)
	if err != nil {
		internal(w, "web_media_usage", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"requests": s.metrics.snapshot(), "lfs_objects": lfsObjects,
		"lfs_bytes": lfsBytes, "reviews": reviewVersions, "renders": renders, "web_media": mediaStates,
		"web_media_bytes": mediaBytes, "oldest_unfinished_media_ms": waitingMillis})
}
