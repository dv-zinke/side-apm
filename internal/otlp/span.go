package otlp

import (
	"encoding/hex"
	"strconv"
	"time"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

type Span struct {
	TenantID        string
	TraceID         string
	SpanID          string
	ParentSpanID    string
	ServiceName     string
	ServiceInstance string
	SpanName        string
	SpanKind        string // SERVER|CLIENT|INTERNAL|PRODUCER|CONSUMER
	StartTime       time.Time
	DurationNs      uint64
	StatusCode      string // UNSET|OK|ERROR
	HTTPMethod      string
	HTTPRoute       string
	HTTPURL         string
	HTTPStatusCode  uint16
	DBSystem        string
	DBStatement     string
	DBName          string
	ResourceAttrs   map[string]string
	SpanAttrs       map[string]string
}

func kindString(k tracepb.Span_SpanKind) string {
	switch k {
	case tracepb.Span_SPAN_KIND_SERVER:
		return "SERVER"
	case tracepb.Span_SPAN_KIND_CLIENT:
		return "CLIENT"
	case tracepb.Span_SPAN_KIND_PRODUCER:
		return "PRODUCER"
	case tracepb.Span_SPAN_KIND_CONSUMER:
		return "CONSUMER"
	case tracepb.Span_SPAN_KIND_INTERNAL:
		return "INTERNAL"
	default:
		return "UNSPECIFIED"
	}
}

func statusString(s *tracepb.Status) string {
	if s == nil {
		return "UNSET"
	}
	switch s.Code {
	case tracepb.Status_STATUS_CODE_OK:
		return "OK"
	case tracepb.Status_STATUS_CODE_ERROR:
		return "ERROR"
	default:
		return "UNSET"
	}
}

func attrString(kv *commonpb.KeyValue) string {
	if kv == nil || kv.Value == nil {
		return ""
	}
	switch v := kv.Value.Value.(type) {
	case *commonpb.AnyValue_StringValue:
		return v.StringValue
	case *commonpb.AnyValue_IntValue:
		return strconv.FormatInt(v.IntValue, 10)
	case *commonpb.AnyValue_DoubleValue:
		return strconv.FormatFloat(v.DoubleValue, 'g', -1, 64)
	case *commonpb.AnyValue_BoolValue:
		return strconv.FormatBool(v.BoolValue)
	default:
		// ArrayValue, KvlistValue left empty for now (out of scope)
		return ""
	}
}

func attrMap(kvs []*commonpb.KeyValue) map[string]string {
	m := make(map[string]string, len(kvs))
	for _, kv := range kvs {
		m[kv.Key] = attrString(kv)
	}
	return m
}

func MapTraces(req *coltracepb.ExportTraceServiceRequest, tenantID string) []Span {
	var out []Span
	for _, rs := range req.GetResourceSpans() {
		res := attrMap(rs.GetResource().GetAttributes())
		for _, ss := range rs.GetScopeSpans() {
			for _, sp := range ss.GetSpans() {
				a := attrMap(sp.GetAttributes())
				httpStatus := uint16(0)
				if v := firstNonEmpty(a["http.response.status_code"], a["http.status_code"]); v != "" {
					if n, err := parseUint16(v); err == nil {
						httpStatus = n
					}
				}
				out = append(out, Span{
					TenantID:        tenantID,
					TraceID:         hex.EncodeToString(sp.GetTraceId()),
					SpanID:          hex.EncodeToString(sp.GetSpanId()),
					ParentSpanID:    hex.EncodeToString(sp.GetParentSpanId()),
					ServiceName:     res["service.name"],
					ServiceInstance: res["service.instance.id"],
					SpanName:        sp.GetName(),
					SpanKind:        kindString(sp.GetKind()),
					StartTime:       time.Unix(0, int64(sp.GetStartTimeUnixNano())).UTC(),
					DurationNs:      sp.GetEndTimeUnixNano() - sp.GetStartTimeUnixNano(),
					StatusCode:      statusString(sp.GetStatus()),
					HTTPMethod:      firstNonEmpty(a["http.request.method"], a["http.method"], httpMethodFromName(sp.GetName(), sp.GetKind())),
					HTTPRoute:       firstNonEmpty(a["http.route"], a["url.path"]),
					HTTPURL:         firstNonEmpty(a["url.full"], a["http.url"], a["server.address"]),
					HTTPStatusCode:  httpStatus,
					DBSystem:        firstNonEmpty(a["db.system"], a["db.system.name"]),
					DBStatement:     firstNonEmpty(a["db.query.text"], a["db.statement"]),
					DBName:          firstNonEmpty(a["db.namespace"], a["db.name"]),
					ResourceAttrs:   res,
					SpanAttrs:       a,
				})
			}
		}
	}
	return out
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}

// HTTP client spans are often named just "GET"/"POST" with method attrs missing
// (semconv drift). Fall back to the span name for CLIENT/SERVER HTTP spans.
func httpMethodFromName(name string, kind tracepb.Span_SpanKind) string {
	if kind != tracepb.Span_SPAN_KIND_CLIENT && kind != tracepb.Span_SPAN_KIND_SERVER {
		return ""
	}
	switch name {
	case "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS":
		return name
	}
	return ""
}

func parseUint16(s string) (uint16, error) {
	var n uint16
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errNotNumber
		}
		n = n*10 + uint16(c-'0')
	}
	return n, nil
}

var errNotNumber = &mapError{"not a number"}

type mapError struct{ msg string }

func (e *mapError) Error() string { return e.msg }
