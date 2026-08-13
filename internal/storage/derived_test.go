package storage

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/heejune/apm/internal/otlp"
)

func testStoreDerived(t *testing.T) *Store {
	dsn := os.Getenv("APM_TEST_CH_DSN")
	if dsn == "" {
		t.Skip("set APM_TEST_CH_DSN")
	}
	s, err := New(dsn)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func TestTraceSummaryPopulates(t *testing.T) {
	s := testStoreDerived(t)
	ctx := context.Background()
	now := time.Now().UTC()
	tid := "ts_" + now.Format("150405.000000000")
	spans := []otlp.Span{
		{TenantID: "default", TraceID: tid, SpanID: "r1", ParentSpanID: "", ServiceName: "SvcA",
			SpanName: "GET /p", SpanKind: "SERVER", StartTime: now, DurationNs: 200_000_000, // 200ms
			StatusCode: "OK", HTTPRoute: "/p", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
		{TenantID: "default", TraceID: tid, SpanID: "c1", ParentSpanID: "r1", ServiceName: "SvcA",
			SpanName: "SELECT", SpanKind: "CLIENT", StartTime: now, DurationNs: 30_000_000, // 30ms sql
			StatusCode: "OK", DBSystem: "postgresql", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
		{TenantID: "default", TraceID: tid, SpanID: "c2", ParentSpanID: "r1", ServiceName: "SvcA",
			SpanName: "GET", SpanKind: "CLIENT", StartTime: now, DurationNs: 50_000_000, // 50ms http
			StatusCode: "OK", HTTPURL: "http://x", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
	}
	if err := s.InsertSpans(ctx, spans); err != nil {
		t.Fatalf("insert: %v", err)
	}
	// MV fires synchronously on insert; read the summary back.
	sum, err := s.GetTraceSummary(ctx, "default", tid)
	if err != nil {
		t.Fatalf("GetTraceSummary: %v", err)
	}
	if sum.EntryService != "SvcA" || sum.TransactionName != "/p" {
		t.Errorf("entry: %q txn: %q", sum.EntryService, sum.TransactionName)
	}
	if sum.SpanCount != 3 {
		t.Errorf("span_count = %d", sum.SpanCount)
	}
	if sum.SqlCount != 1 || sum.HttpCallCount != 1 {
		t.Errorf("sql=%d http=%d", sum.SqlCount, sum.HttpCallCount)
	}
	if sum.DurationMs < 199 || sum.DurationMs > 201 {
		t.Errorf("elapsed ms = %v (want ~200)", sum.DurationMs)
	}
	if sum.SqlTimeMs < 29 || sum.SqlTimeMs > 31 {
		t.Errorf("sql ms = %v (want ~30)", sum.SqlTimeMs)
	}
}

func TestServiceRED(t *testing.T) {
	s := testStoreDerived(t)
	ctx := context.Background()
	now := time.Now().UTC()
	svc := "RedSvc" + now.Format("150405")
	spans := []otlp.Span{
		{TenantID: "default", TraceID: "rd1", SpanID: "s1", ServiceName: svc, SpanName: "GET /a",
			SpanKind: "SERVER", StartTime: now, DurationNs: 100_000_000, StatusCode: "OK",
			ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
		{TenantID: "default", TraceID: "rd2", SpanID: "s2", ServiceName: svc, SpanName: "GET /a",
			SpanKind: "SERVER", StartTime: now, DurationNs: 300_000_000, StatusCode: "ERROR",
			ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
	}
	if err := s.InsertSpans(ctx, spans); err != nil {
		t.Fatalf("insert: %v", err)
	}
	pts, err := s.GetServiceRED(ctx, "default", svc, now.Add(-2*time.Minute), now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("GetServiceRED: %v", err)
	}
	var reqs, errs uint64
	for _, p := range pts {
		reqs += p.RequestCount
		errs += p.ErrorCount
	}
	if reqs != 2 || errs != 1 {
		t.Fatalf("reqs=%d errs=%d (want 2,1)", reqs, errs)
	}
}
