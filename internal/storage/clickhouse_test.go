package storage

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/heejune/apm/internal/otlp"
)

func testStore(t *testing.T) *Store {
	dsn := os.Getenv("APM_TEST_CH_DSN")
	if dsn == "" {
		t.Skip("set APM_TEST_CH_DSN to run (e.g. clickhouse://localhost:9000/apm)")
	}
	s, err := New(dsn)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func TestInsertAndQuery(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	spans := []otlp.Span{
		{TenantID: "default", TraceID: "aa11", SpanID: "01", ServiceName: "GatewayService",
			SpanName: "GET /x", SpanKind: "SERVER", StartTime: now, DurationNs: 1424000000,
			StatusCode: "OK", HTTPRoute: "/x", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
		{TenantID: "default", TraceID: "aa11", SpanID: "02", ParentSpanID: "01", ServiceName: "GatewayService",
			SpanName: "SELECT", SpanKind: "CLIENT", StartTime: now, DurationNs: 100000,
			StatusCode: "OK", DBSystem: "postgresql", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
	}
	if err := s.InsertSpans(ctx, spans); err != nil {
		t.Fatalf("InsertSpans: %v", err)
	}

	txns, err := s.ListTransactions(ctx, "default", Filter{Limit: 10})
	if err != nil {
		t.Fatalf("ListTransactions: %v", err)
	}
	found := false
	for _, r := range txns {
		if r.TraceID == "aa11" && r.ServiceName == "GatewayService" {
			found = true
		}
	}
	if !found {
		t.Fatalf("transaction aa11 not in %+v", txns)
	}

	got, err := s.GetTraceSpans(ctx, "default", "aa11")
	if err != nil {
		t.Fatalf("GetTraceSpans: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 spans, got %d", len(got))
	}
}
