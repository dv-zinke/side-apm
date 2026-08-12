package gateway

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"google.golang.org/protobuf/proto"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"

	"github.com/heejune/apm/internal/otlp"
)

type capBuf struct{ got []otlp.Span }

func (c *capBuf) Publish(_ context.Context, spans []otlp.Span) error {
	c.got = append(c.got, spans...)
	return nil
}

func TestTracesHandler_Accepts(t *testing.T) {
	req := &coltracepb.ExportTraceServiceRequest{
		ResourceSpans: []*tracepb.ResourceSpans{{
			Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{{
				Key: "service.name", Value: &commonpb.AnyValue{
					Value: &commonpb.AnyValue_StringValue{StringValue: "Svc"}}}}},
			ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{{
				TraceId: []byte("0123456789abcdef"), SpanId: []byte("01234567"),
				Name: "op", Kind: tracepb.Span_SPAN_KIND_SERVER,
			}}}},
		}},
	}
	body, _ := proto.Marshal(req)

	cb := &capBuf{}
	h := TracesHandler(cb)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/traces", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/x-protobuf")
	h(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if len(cb.got) != 1 || cb.got[0].ServiceName != "Svc" {
		t.Fatalf("published = %+v", cb.got)
	}
}
