package query

import (
	"context"
	"net/http"
	"time"

	"github.com/heejune/apm/internal/storage"
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
		s, err := r.GetTraceSummary(req.Context(), tenantOf(req), req.PathValue("traceID"))
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
		svcs, err := r.ListServices(req.Context(), tenantOf(req))
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
		pts, err := r.GetServiceRED(req.Context(), tenantOf(req), req.PathValue("name"), from, to)
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
	// All-services RED in ONE query, auto-routed by window length to the right
	// tier: minute rollup (fine) for short windows, hourly rollup (frozen, 24mo)
	// for long/old windows. The client just sends from/to; the server picks the
	// source + bucket and reports the chosen resolution back for honest labeling.
	mux.HandleFunc("GET /api/v1/red", func(w http.ResponseWriter, req *http.Request) {
		from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), time.Hour)
		m, resolution, err := allServicesREDRouted(req.Context(), r, tenantOf(req), from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		series := make(map[string][]REDPointDTO, len(m))
		for svc, pts := range m {
			s := make([]REDPointDTO, 0, len(pts))
			for _, p := range pts {
				s = append(s, REDPointDTO{
					Minute: p.Minute.Format(time.RFC3339), RequestCount: p.RequestCount, ErrorCount: p.ErrorCount,
					P50Ms: p.P50Ms, P95Ms: p.P95Ms, P99Ms: p.P99Ms,
				})
			}
			series[svc] = s
		}
		writeJSON(w, REDResponse{
			Resolution: resolution,
			From:       from.Format(time.RFC3339),
			To:         to.Format(time.RFC3339),
			Series:     series,
		})
	})

	// Retention horizons — the single source of truth for how far back each
	// fidelity tier is queryable, so the UI can warn honestly when a chosen
	// window predates trace-level (or minute-level) availability.
	mux.HandleFunc("GET /api/v1/meta/retention", func(w http.ResponseWriter, req *http.Request) {
		writeJSON(w, retentionMeta)
	})
}

// REDResponse wraps the per-service series with the resolution actually served.
type REDResponse struct {
	Resolution string                   `json:"resolution"` // 1m|5m|15m|1h|6h|1d
	From       string                   `json:"from"`
	To         string                   `json:"to"`
	Series     map[string][]REDPointDTO `json:"series"`
}

// retentionMeta mirrors the schema TTLs (days). traceDays gates individual-trace
// drill-down; minuteDays/hourDays gate metric resolution.
var retentionMeta = struct {
	TraceDays  int `json:"traceDays"`  // apm.spans + trace_summary TTL
	MinuteDays int `json:"minuteDays"` // apm.red_rollup TTL
	HourDays   int `json:"hourDays"`   // apm.red_rollup_1h TTL
}{TraceDays: 30, MinuteDays: 180, HourDays: 730}

// allServicesREDRouted picks the storage tier + bucket for the window and returns
// the series plus a resolution label. Boundaries chosen so no query scans more
// than a few hundred buckets/service.
func allServicesREDRouted(ctx context.Context, r Reader, tenant string, from, to time.Time) (map[string][]storage.REDPoint, string, error) {
	span := to.Sub(from)
	switch {
	case span <= 2*time.Hour:
		m, err := r.AllServicesREDStep(ctx, tenant, from, to, 1)
		return m, "1m", err
	case span <= 12*time.Hour:
		m, err := r.AllServicesREDStep(ctx, tenant, from, to, 5)
		return m, "5m", err
	case span <= 48*time.Hour:
		m, err := r.AllServicesREDStep(ctx, tenant, from, to, 15)
		return m, "15m", err
	case span <= 14*24*time.Hour:
		m, err := r.AllServicesREDHourly(ctx, tenant, from, to, 1)
		return m, "1h", err
	case span <= 60*24*time.Hour:
		m, err := r.AllServicesREDHourly(ctx, tenant, from, to, 6)
		return m, "6h", err
	default:
		m, err := r.AllServicesREDHourly(ctx, tenant, from, to, 24)
		return m, "1d", err
	}
}
