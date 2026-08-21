package query

import (
	"net/http"
	"strconv"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type LogDTO struct {
	Time     string `json:"time"`
	Service  string `json:"service"`
	Severity string `json:"severity"`
	Body     string `json:"body"`
	TraceID  string `json:"traceId"`
	SpanID   string `json:"spanId"`
}

func toLogDTOs(rows []storage.LogRow) []LogDTO {
	out := make([]LogDTO, 0, len(rows))
	for _, l := range rows {
		out = append(out, LogDTO{
			Time: l.Time.Format(time.RFC3339Nano), Service: l.Service, Severity: l.Severity,
			Body: l.Body, TraceID: l.TraceID, SpanID: l.SpanID,
		})
	}
	return out
}

func registerLogs(mux *http.ServeMux, r Reader) {
	// Logs correlated to a trace (3-pillars drill-down).
	mux.HandleFunc("GET /api/v1/traces/{traceID}/logs", func(w http.ResponseWriter, req *http.Request) {
		rows, err := r.GetTraceLogs(req.Context(), tenantOf(req), req.PathValue("traceID"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, toLogDTOs(rows))
	})

	// Log search/list.
	mux.HandleFunc("GET /api/v1/logs", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		from, to := resolveWindow(q.Get("from"), q.Get("to"), time.Hour)
		rows, err := r.ListLogs(req.Context(), tenantOf(req), storage.LogFilter{
			Service: q.Get("service"), Severity: q.Get("severity"), Query: q.Get("q"),
			Limit: limit, From: from, To: to,
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, toLogDTOs(rows))
	})

	// Log search — the safe restricted DSL over apm.logs. Plain filter returns
	// log rows; a `| stats … by …` pipe returns facets. Bad DSL → 400 + message.
	mux.HandleFunc("GET /api/v1/logs/query", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		from, to := resolveWindow(q.Get("from"), q.Get("to"), time.Hour)
		limit, _ := strconv.Atoi(q.Get("limit"))
		res, err := r.RunLogQuery(req.Context(), tenantOf(req), q.Get("q"), from, to, limit)
		if err != nil {
			if storage.IsQueryError(err) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := SpanQueryDTO{Kind: res.Kind}
		if res.Kind == "facets" {
			out.Kind = "facets"
			out.Fields = res.Facet.Fields
			out.AggLabels = res.Facet.AggLabels
			out.Rows = make([]FacetRowDTO, 0, len(res.Facet.Rows))
			for _, fr := range res.Facet.Rows {
				out.Rows = append(out.Rows, FacetRowDTO{Key: fr.Key, Values: fr.Values})
			}
			writeJSON(w, out)
			return
		}
		// rows: reuse the log DTO shape under a tagged envelope.
		writeJSON(w, map[string]any{"kind": "rows", "rows": toLogDTOs(res.Rows)})
	})

	// Log patterns — cluster millions of lines into normalized templates.
	mux.HandleFunc("GET /api/v1/logs/patterns", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		from, to := resolveWindow(q.Get("from"), q.Get("to"), time.Hour)
		pats, err := r.LogPatterns(req.Context(), tenantOf(req), q.Get("severity"), from, to, limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]map[string]any, 0, len(pats))
		for _, p := range pats {
			out = append(out, map[string]any{
				"pattern": p.Pattern, "sample": p.Sample, "count": p.Count, "errors": p.Errors,
				"services": p.Services, "lastSeen": p.LastSeen.Format(time.RFC3339),
			})
		}
		writeJSON(w, out)
	})
}
