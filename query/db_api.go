package query

import (
	"net/http"
	"strconv"
	"time"
)

type QueryStatDTO struct {
	Service   string  `json:"service"`
	Statement string  `json:"statement"`
	DBSystem  string  `json:"dbSystem"`
	Calls     uint64  `json:"calls"`
	AvgMs     float64 `json:"avgMs"`
	P95Ms     float64 `json:"p95Ms"`
	MaxMs     float64 `json:"maxMs"`
	TotalMs   float64 `json:"totalMs"`
}

func registerDB(mux *http.ServeMux, r Reader) {
	// Aggregated DB query stats — database monitoring / slow-query view.
	mux.HandleFunc("GET /api/v1/db/queries", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		from, to := resolveWindow(q.Get("from"), q.Get("to"), time.Hour)
		stats, err := r.TopQueries(req.Context(), tenantOf(req), q.Get("service"), q.Get("orderBy"), from, to, limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]QueryStatDTO, 0, len(stats))
		for _, s := range stats {
			out = append(out, QueryStatDTO{
				Service: s.Service, Statement: s.Statement, DBSystem: s.DBSystem, Calls: s.Calls,
				AvgMs: s.AvgMs, P95Ms: s.P95Ms, MaxMs: s.MaxMs, TotalMs: s.TotalMs,
			})
		}
		writeJSON(w, out)
	})

	// N+1 detection — statements repeated many times within a single trace.
	mux.HandleFunc("GET /api/v1/db/nplusone", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		minRepeats, _ := strconv.Atoi(q.Get("minRepeats"))
		limit, _ := strconv.Atoi(q.Get("limit"))
		from, to := resolveWindow(q.Get("from"), q.Get("to"), time.Hour)
		stats, err := r.NPlusOne(req.Context(), tenantOf(req), minRepeats, limit, from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]map[string]any, 0, len(stats))
		for _, s := range stats {
			out = append(out, map[string]any{
				"service": s.Service, "statement": s.Statement, "traces": s.Traces,
				"avgRepeats": s.AvgRepeats, "maxRepeats": s.MaxRepeats, "totalMs": s.TotalMs,
			})
		}
		writeJSON(w, out)
	})
}
