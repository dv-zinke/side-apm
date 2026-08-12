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
