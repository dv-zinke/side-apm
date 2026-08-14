package query

import (
	"net/http"
	"strconv"
	"time"
)

type MetricPointDTO struct {
	Time  string  `json:"time"`
	Value float64 `json:"value"`
}

func registerMetrics(mux *http.ServeMux, r Reader) {
	// Distinct metric names available for a service.
	mux.HandleFunc("GET /api/v1/services/{name}/metric-names", func(w http.ResponseWriter, req *http.Request) {
		names, err := r.ListMetricNames(req.Context(), defaultTenant, req.PathValue("name"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if names == nil {
			names = []string{}
		}
		writeJSON(w, names)
	})

	// One metric's timeseries (10s buckets) over a window.
	mux.HandleFunc("GET /api/v1/services/{name}/metrics", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		metric := q.Get("name")
		if metric == "" {
			http.Error(w, "name required", http.StatusBadRequest)
			return
		}
		to := time.Now().UTC()
		from := to.Add(-1 * time.Hour)
		if v := q.Get("from"); v != "" {
			if p, err := time.Parse(time.RFC3339, v); err == nil {
				from = p
			}
		}
		if v := q.Get("to"); v != "" {
			if p, err := time.Parse(time.RFC3339, v); err == nil {
				to = p
			}
		}
		pts, err := r.GetServiceMetric(req.Context(), defaultTenant, req.PathValue("name"), metric, from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]MetricPointDTO, 0, len(pts))
		for _, p := range pts {
			out = append(out, MetricPointDTO{Time: p.Time.Format(time.RFC3339), Value: p.Value})
		}
		writeJSON(w, out)
	})

	// Server-side Apdex from real latency histograms (not stream-approximated).
	mux.HandleFunc("GET /api/v1/services/{name}/apdex", func(w http.ResponseWriter, req *http.Request) {
		tMs := 500.0
		if v := req.URL.Query().Get("t"); v != "" {
			if p, err := strconv.ParseFloat(v, 64); err == nil && p > 0 {
				tMs = p
			}
		}
		to := time.Now().UTC()
		from := to.Add(-5 * time.Minute)
		if v := req.URL.Query().Get("windowMin"); v != "" {
			if m, err := strconv.Atoi(v); err == nil && m > 0 {
				from = to.Add(-time.Duration(m) * time.Minute)
			}
		}
		score, n, ok, err := r.ServiceApdex(req.Context(), defaultTenant, req.PathValue("name"), tMs, from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		p50, p95, p99, pok, err := r.ServicePercentiles(req.Context(), defaultTenant, req.PathValue("name"), from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{
			"tMs": tMs, "score": score, "samples": n, "hasData": ok,
			"p50Ms": p50, "p95Ms": p95, "p99Ms": p99, "hasPercentiles": pok,
		})
	})
}
