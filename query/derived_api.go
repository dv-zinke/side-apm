package query

import (
	"net/http"
	"time"
)

type TraceSummaryDTO struct {
	TraceID         string  `json:"traceId"`
	EntryService    string  `json:"entryService"`
	TransactionName string  `json:"transactionName"`
	RootHTTPStatus  uint16  `json:"rootHttpStatus"`
	StartTime       string  `json:"startTime"`
	DurationMs      float64 `json:"durationMs"`
	SpanCount       uint64  `json:"spanCount"`
	ErrorCount      uint64  `json:"errorCount"`
	SqlCount        uint64  `json:"sqlCount"`
	HttpCallCount   uint64  `json:"httpCallCount"`
	SqlTimeMs       float64 `json:"sqlTimeMs"`
	HttpCallTimeMs  float64 `json:"httpCallTimeMs"`
}

type REDPointDTO struct {
	Minute       string  `json:"minute"`
	RequestCount uint64  `json:"requestCount"`
	ErrorCount   uint64  `json:"errorCount"`
	P50Ms        float64 `json:"p50Ms"`
	P95Ms        float64 `json:"p95Ms"`
	P99Ms        float64 `json:"p99Ms"`
}

func registerDerived(mux *http.ServeMux, r Reader) {
	mux.HandleFunc("GET /api/v1/transactions/{traceID}/summary", func(w http.ResponseWriter, req *http.Request) {
		s, err := r.GetTraceSummary(req.Context(), defaultTenant, req.PathValue("traceID"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, TraceSummaryDTO{
			TraceID: s.TraceID, EntryService: s.EntryService, TransactionName: s.TransactionName,
			RootHTTPStatus: s.RootHTTPStatus, StartTime: s.StartTime.Format("2006-01-02T15:04:05.000Z"),
			DurationMs: s.DurationMs, SpanCount: s.SpanCount, ErrorCount: s.ErrorCount,
			SqlCount: s.SqlCount, HttpCallCount: s.HttpCallCount,
			SqlTimeMs: s.SqlTimeMs, HttpCallTimeMs: s.HttpCallTimeMs,
		})
	})
	mux.HandleFunc("GET /api/v1/services", func(w http.ResponseWriter, req *http.Request) {
		svcs, err := r.ListServices(req.Context(), defaultTenant)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if svcs == nil {
			svcs = []string{}
		}
		writeJSON(w, svcs)
	})
	mux.HandleFunc("GET /api/v1/services/{name}/red", func(w http.ResponseWriter, req *http.Request) {
		from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), time.Hour)
		pts, err := r.GetServiceRED(req.Context(), defaultTenant, req.PathValue("name"), from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]REDPointDTO, 0, len(pts))
		for _, p := range pts {
			out = append(out, REDPointDTO{
				Minute: p.Minute.Format(time.RFC3339), RequestCount: p.RequestCount, ErrorCount: p.ErrorCount,
				P50Ms: p.P50Ms, P95Ms: p.P95Ms, P99Ms: p.P99Ms,
			})
		}
		writeJSON(w, out)
	})
}
