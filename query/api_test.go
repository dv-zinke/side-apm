package query

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/heejune/apm/internal/otlp"
	"github.com/heejune/apm/internal/storage"
)

type fakeReader struct{}

func (fakeReader) ListTransactions(_ context.Context, tenant string, f storage.Filter) ([]storage.TransactionRow, error) {
	return []storage.TransactionRow{{
		TraceID: "aa11", ServiceName: "GatewayService", TransactionName: "GET /x",
		StatusCode: "OK", StartTime: time.Unix(0, 0).UTC(), DurationNs: 1424000000,
	}}, nil
}

func (fakeReader) GetTraceSpans(_ context.Context, tenant, traceID string) ([]otlp.Span, error) {
	return []otlp.Span{{
		TraceID: traceID, SpanID: "01", SpanName: "GET /x", SpanKind: "SERVER",
		DurationNs: 500000, // 0.5ms — tests sub-millisecond precision
	}}, nil
}

func (fakeReader) GetTraceSummary(_ context.Context, _, traceID string) (storage.TraceSummaryRow, error) {
	return storage.TraceSummaryRow{}, nil
}

func (fakeReader) ListServices(_ context.Context, _ string) ([]string, error) {
	return nil, nil
}

func (fakeReader) GetServiceRED(_ context.Context, _, _ string, _, _ time.Time) ([]storage.REDPoint, error) {
	return nil, nil
}

func (fakeReader) GetServiceMap(_ context.Context, _ string, _, _ time.Time) (storage.ServiceMap, error) {
	return storage.ServiceMap{}, nil
}

func (fakeReader) RecentRootTxns(_ context.Context, _ string, _ time.Time, _ int) ([]storage.LiveTxn, error) {
	return nil, nil
}

func (fakeReader) ListMetricNames(_ context.Context, _, _ string) ([]string, error) {
	return nil, nil
}

func (fakeReader) GetServiceMetric(_ context.Context, _, _, _ string, _, _ time.Time) ([]storage.MetricPoint, error) {
	return nil, nil
}

func (fakeReader) GetTraceLogs(_ context.Context, _, _ string) ([]storage.LogRow, error) {
	return nil, nil
}

func (fakeReader) ListLogs(_ context.Context, _ string, _ storage.LogFilter) ([]storage.LogRow, error) {
	return nil, nil
}

func (fakeReader) ListAlertRules(_ context.Context, _ string) ([]storage.AlertRule, error) {
	return nil, nil
}

func (fakeReader) UpsertAlertRule(_ context.Context, _ string, _ storage.AlertRule) error {
	return nil
}

func (fakeReader) DeleteAlertRule(_ context.Context, _, _ string) error { return nil }

func (fakeReader) ListAlerts(_ context.Context, _ string, _ int) ([]storage.Alert, error) {
	return nil, nil
}

func (fakeReader) ServiceApdex(_ context.Context, _, _ string, _ float64, _, _ time.Time) (float64, uint64, bool, error) {
	return 0, 0, false, nil
}

func (fakeReader) ServicePercentiles(_ context.Context, _, _ string, _, _ time.Time) (float64, float64, float64, bool, error) {
	return 0, 0, 0, false, nil
}

func TestListTransactionsEndpoint(t *testing.T) {
	srv := httptest.NewServer(Router(fakeReader{}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/v1/transactions?limit=10")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var got []TransactionDTO
	json.NewDecoder(resp.Body).Decode(&got)
	if len(got) != 1 || got[0].TraceID != "aa11" || got[0].DurationMs != float64(1424) {
		t.Fatalf("dto = %+v", got)
	}
}

func TestTraceSpansEndpoint(t *testing.T) {
	srv := httptest.NewServer(Router(fakeReader{}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/v1/traces/aa11/spans")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []SpanDTO
	json.NewDecoder(resp.Body).Decode(&got)
	if len(got) != 1 || got[0].SpanID != "01" || got[0].DurationMs != 0.5 {
		t.Fatalf("dto = %+v", got)
	}
}
