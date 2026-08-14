package query

import (
	"net/http"
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
}
