package query

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/heejune/apm/internal/otlp"
	"github.com/heejune/apm/internal/storage"
)

const defaultTenant = "default" // Phase 4에서 인증 컨텍스트로 대체

type Reader interface {
	ListTransactions(ctx context.Context, tenant string, f storage.Filter) ([]storage.TransactionRow, error)
	GetTraceSpans(ctx context.Context, tenant, traceID string) ([]otlp.Span, error)
	GetTraceSummary(ctx context.Context, tenant, traceID string) (storage.TraceSummaryRow, error)
	ListServices(ctx context.Context, tenant string) ([]string, error)
	GetServiceRED(ctx context.Context, tenant, service string, from, to time.Time) ([]storage.REDPoint, error)
	GetServiceMap(ctx context.Context, tenant string, from, to time.Time) (storage.ServiceMap, error)
	RecentRootTxns(ctx context.Context, tenant string, since time.Time, limit int) ([]storage.LiveTxn, error)
	BackfillTxns(ctx context.Context, tenant string, since time.Time, limit int) ([]storage.LiveTxn, error)
	ListMetricNames(ctx context.Context, tenant, service string) ([]string, error)
	GetServiceMetric(ctx context.Context, tenant, service, name string, from, to time.Time) ([]storage.MetricPoint, error)
	GetTraceLogs(ctx context.Context, tenant, traceID string) ([]storage.LogRow, error)
	ListLogs(ctx context.Context, tenant string, f storage.LogFilter) ([]storage.LogRow, error)
	ListAlertRules(ctx context.Context, tenant string) ([]storage.AlertRule, error)
	UpsertAlertRule(ctx context.Context, tenant string, r storage.AlertRule) error
	DeleteAlertRule(ctx context.Context, tenant, id string) error
	ListAlerts(ctx context.Context, tenant string, limit int) ([]storage.Alert, error)
	ServiceApdex(ctx context.Context, tenant, service string, tMs float64, from, to time.Time) (float64, uint64, bool, error)
	ServicePercentiles(ctx context.Context, tenant, service string, from, to time.Time) (p50, p95, p99 float64, ok bool, err error)
	TopQueries(ctx context.Context, tenant, orderBy string, from, to time.Time, limit int) ([]storage.QueryStat, error)
	NPlusOne(ctx context.Context, tenant string, minRepeats, limit int, from, to time.Time) ([]storage.NPlusOneStat, error)
	RumOverview(ctx context.Context, tenant string, from, to time.Time) (storage.RumOverview, error)
	TopClicks(ctx context.Context, tenant string, from, to time.Time, limit int) ([]storage.RumCount, error)
	TopErrors(ctx context.Context, tenant string, from, to time.Time, limit int) ([]storage.RumCount, error)
	TopResources(ctx context.Context, tenant string, from, to time.Time, limit int) ([]storage.RumCount, error)
	ListReplays(ctx context.Context, tenant string, from, to time.Time, limit int) ([]storage.ReplayMeta, error)
	GetReplay(ctx context.Context, tenant, id string) (string, error)
	ListContainers(ctx context.Context, tenant string, from, to time.Time) ([]storage.ContainerStat, error)
	ContainerSeries(ctx context.Context, tenant, container, metric string, from, to time.Time) ([]storage.MetricPoint, error)
}

type TransactionDTO struct {
	TraceID         string  `json:"traceId"`
	ServiceName     string  `json:"serviceName"`
	TransactionName string  `json:"transactionName"`
	StatusCode      string  `json:"statusCode"`
	StartTime       string  `json:"startTime"`
	DurationMs      float64 `json:"durationMs"`
}

type SpanDTO struct {
	TraceID      string  `json:"traceId"`
	SpanID       string  `json:"spanId"`
	ParentSpanID string  `json:"parentSpanId"`
	ServiceName  string  `json:"serviceName"`
	SpanName     string  `json:"spanName"`
	SpanKind     string  `json:"spanKind"`
	StartTime    string  `json:"startTime"`
	DurationMs   float64 `json:"durationMs"`
	StatusCode   string  `json:"statusCode"`
	HTTPMethod   string  `json:"httpMethod,omitempty"`
	HTTPRoute    string  `json:"httpRoute,omitempty"`
	HTTPURL      string  `json:"httpUrl,omitempty"`
	DBSystem     string  `json:"dbSystem,omitempty"`
	DBStatement  string  `json:"dbStatement,omitempty"`
}

func Router(r Reader) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/transactions", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		minMs, _ := strconv.ParseFloat(q.Get("minMs"), 64)
		rows, err := r.ListTransactions(req.Context(), defaultTenant, storage.Filter{
			Service:    q.Get("service"),
			ErrorsOnly: q.Get("errors") == "1" || q.Get("errors") == "true",
			MinMs:      minMs,
			Query:      q.Get("q"),
			Limit:      limit,
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]TransactionDTO, 0, len(rows))
		for _, t := range rows {
			out = append(out, TransactionDTO{
				TraceID: t.TraceID, ServiceName: t.ServiceName, TransactionName: t.TransactionName,
				StatusCode: t.StatusCode, StartTime: t.StartTime.Format("2006-01-02T15:04:05.000Z"),
				DurationMs: float64(t.DurationNs) / 1e6,
			})
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("GET /api/v1/traces/{traceID}/spans", func(w http.ResponseWriter, req *http.Request) {
		spans, err := r.GetTraceSpans(req.Context(), defaultTenant, req.PathValue("traceID"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]SpanDTO, 0, len(spans))
		for _, s := range spans {
			out = append(out, SpanDTO{
				TraceID: s.TraceID, SpanID: s.SpanID, ParentSpanID: s.ParentSpanID,
				ServiceName: s.ServiceName, SpanName: s.SpanName, SpanKind: s.SpanKind,
				StartTime:  s.StartTime.Format("2006-01-02T15:04:05.000Z"),
				DurationMs: float64(s.DurationNs) / 1e6, StatusCode: s.StatusCode,
				HTTPMethod: s.HTTPMethod, HTTPRoute: s.HTTPRoute, HTTPURL: s.HTTPURL,
				DBSystem: s.DBSystem, DBStatement: s.DBStatement,
			})
		}
		writeJSON(w, out)
	})
	registerDerived(mux, r)
	registerServiceMap(mux, r)
	registerMetrics(mux, r)
	registerLogs(mux, r)
	registerAlerts(mux, r)
	registerDB(mux, r)
	registerRum(mux, r)
	registerInfra(mux, r)
	return withCORS(mux)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func withCORS(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}
