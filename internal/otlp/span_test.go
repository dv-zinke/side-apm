package otlp

import (
	"testing"
	"time"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

func strAttr(k, v string) *commonpb.KeyValue {
	return &commonpb.KeyValue{Key: k, Value: &commonpb.AnyValue{
		Value: &commonpb.AnyValue_StringValue{StringValue: v}}}
}

func TestMapTraces_ServerSpanWithHTTP(t *testing.T) {
	start := time.Date(2026, 8, 13, 6, 42, 56, 843000000, time.UTC)
	req := &coltracepb.ExportTraceServiceRequest{
		ResourceSpans: []*tracepb.ResourceSpans{{
			Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{
				strAttr("service.name", "GatewayService"),
			}},
			ScopeSpans: []*tracepb.ScopeSpans{{
				Spans: []*tracepb.Span{{
					TraceId:           []byte{0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0x9, 0xa, 0xb, 0xc, 0xd, 0xe, 0xf, 0x10},
					SpanId:            []byte{0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8},
					Name:              "GET /buy-request",
					Kind:              tracepb.Span_SPAN_KIND_SERVER,
					StartTimeUnixNano: uint64(start.UnixNano()),
					EndTimeUnixNano:   uint64(start.Add(1424 * time.Millisecond).UnixNano()),
					Status:            &tracepb.Status{Code: tracepb.Status_STATUS_CODE_OK},
					Attributes: []*commonpb.KeyValue{
						strAttr("http.request.method", "GET"),
						strAttr("http.route", "/buy-request"),
					},
				}},
			}},
		}},
	}

	got := MapTraces(req, "default")
	if len(got) != 1 {
		t.Fatalf("want 1 span, got %d", len(got))
	}
	s := got[0]
	if s.TenantID != "default" {
		t.Errorf("tenant: %q", s.TenantID)
	}
	if s.TraceID != "0102030405060708090a0b0c0d0e0f10" {
		t.Errorf("trace_id: %q", s.TraceID)
	}
	if s.ServiceName != "GatewayService" {
		t.Errorf("service: %q", s.ServiceName)
	}
	if s.SpanKind != "SERVER" {
		t.Errorf("kind: %q", s.SpanKind)
	}
	if s.DurationNs != uint64(1424*time.Millisecond) {
		t.Errorf("duration: %d", s.DurationNs)
	}
	if s.StatusCode != "OK" {
		t.Errorf("status: %q", s.StatusCode)
	}
	if s.HTTPMethod != "GET" || s.HTTPRoute != "/buy-request" {
		t.Errorf("http: %q %q", s.HTTPMethod, s.HTTPRoute)
	}
}
