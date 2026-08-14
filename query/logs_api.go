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
		rows, err := r.GetTraceLogs(req.Context(), defaultTenant, req.PathValue("traceID"))
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
		rows, err := r.ListLogs(req.Context(), defaultTenant, storage.LogFilter{
			Service: q.Get("service"), Severity: q.Get("severity"), Query: q.Get("q"),
			Limit: limit, From: from, To: to,
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, toLogDTOs(rows))
	})
}
