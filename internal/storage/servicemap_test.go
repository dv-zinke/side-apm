package storage

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/heejune/apm/internal/otlp"
)

func testStoreSM(t *testing.T) *Store {
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

func TestGetServiceMap(t *testing.T) {
	s := testStoreSM(t)
	ctx := context.Background()
	now := time.Now().UTC()
	tr := "sm_" + now.Format("150405.000000000")
	// A(root SERVER) -> A(CLIENT) -> B(SERVER child): edge A->B
	spans := []otlp.Span{
		{TenantID: "default", TraceID: tr, SpanID: "a_srv", ParentSpanID: "", ServiceName: "Amap",
			SpanName: "GET /a", SpanKind: "SERVER", StartTime: now, DurationNs: 100_000_000, StatusCode: "OK",
			ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
		{TenantID: "default", TraceID: tr, SpanID: "a_cli", ParentSpanID: "a_srv", ServiceName: "Amap",
			SpanName: "GET", SpanKind: "CLIENT", StartTime: now, DurationNs: 60_000_000, StatusCode: "OK",
			HTTPURL: "http://b", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
		{TenantID: "default", TraceID: tr, SpanID: "b_srv", ParentSpanID: "a_cli", ServiceName: "Bmap",
			SpanName: "GET /b", SpanKind: "SERVER", StartTime: now, DurationNs: 50_000_000, StatusCode: "OK",
			ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
	}
	if err := s.InsertSpans(ctx, spans); err != nil {
		t.Fatalf("insert: %v", err)
	}
	sm, err := s.GetServiceMap(ctx, "default", now.Add(-2*time.Minute), now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("GetServiceMap: %v", err)
	}
	hasNode := func(n string) bool {
		for _, x := range sm.Nodes {
			if x.Name == n {
				return true
			}
		}
		return false
	}
	if !hasNode("Amap") || !hasNode("Bmap") {
		t.Fatalf("nodes missing: %+v", sm.Nodes)
	}
	found := false
	for _, e := range sm.Edges {
		if e.From == "Amap" && e.To == "Bmap" && e.CallCount >= 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("edge Amap->Bmap missing: %+v", sm.Edges)
	}
}

func TestRecentRootTxns(t *testing.T) {
	s := testStoreSM(t)
	ctx := context.Background()
	now := time.Now().UTC()
	tr := "lt_" + now.Format("150405.000000000")
	spans := []otlp.Span{
		{TenantID: "default", TraceID: tr, SpanID: "root", ParentSpanID: "", ServiceName: "LiveSvc",
			SpanName: "GET /live", SpanKind: "SERVER", StartTime: now, DurationNs: 42_000_000, StatusCode: "OK",
			HTTPRoute: "/live", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
	}
	if err := s.InsertSpans(ctx, spans); err != nil {
		t.Fatalf("insert: %v", err)
	}
	txns, err := s.RecentRootTxns(ctx, "default", now.Add(-1*time.Minute), 100)
	if err != nil {
		t.Fatalf("RecentRootTxns: %v", err)
	}
	found := false
	for _, x := range txns {
		if x.TraceID == tr {
			found = true
			if x.Service != "LiveSvc" || x.DurationMs < 41 || x.DurationMs > 43 {
				t.Errorf("bad txn: %+v", x)
			}
		}
	}
	if !found {
		t.Fatalf("recent txn %s not found in %d rows", tr, len(txns))
	}
}
