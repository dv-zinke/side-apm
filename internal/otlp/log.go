package otlp

import (
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	collogspb "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	logspb "go.opentelemetry.io/proto/otlp/logs/v1"
)

type LogRecord struct {
	TenantID    string
	Time        time.Time
	ServiceName string
	Severity    string
	Body        string
	TraceID     string
	SpanID      string
	Attrs       map[string]string
}

func anyValueString(v *commonpb.AnyValue) string {
	if v == nil {
		return ""
	}
	switch x := v.Value.(type) {
	case *commonpb.AnyValue_StringValue:
		return x.StringValue
	case *commonpb.AnyValue_IntValue:
		return strconv.FormatInt(x.IntValue, 10)
	case *commonpb.AnyValue_DoubleValue:
		return strconv.FormatFloat(x.DoubleValue, 'g', -1, 64)
	case *commonpb.AnyValue_BoolValue:
		if x.BoolValue {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

// MapLogs flattens OTLP log records into rows, preserving trace/span ids for
// trace↔log correlation.
func MapLogs(req *collogspb.ExportLogsServiceRequest, tenantID string) []LogRecord {
	var out []LogRecord
	for _, rl := range req.GetResourceLogs() {
		res := attrMap(rl.GetResource().GetAttributes())
		service := res["service.name"]
		for _, sl := range rl.GetScopeLogs() {
			for _, lr := range sl.GetLogRecords() {
				ts := lr.GetTimeUnixNano()
				if ts == 0 {
					ts = lr.GetObservedTimeUnixNano()
				}
				out = append(out, LogRecord{
					TenantID:    tenantID,
					Time:        time.Unix(0, int64(ts)).UTC(),
					ServiceName: service,
					Severity:    severityText(lr),
					Body:        anyValueString(lr.GetBody()),
					TraceID:     hex.EncodeToString(lr.GetTraceId()),
					SpanID:      hex.EncodeToString(lr.GetSpanId()),
					Attrs:       attrMap(lr.GetAttributes()),
				})
			}
		}
	}
	return out
}

// severityText normalizes to upper-case so filters match regardless of whether
// the source sent "error"/"ERROR" (pino sends lower-case severityText, other
// agents send upper). Consistent storage keeps exact-match severity filters honest.
func severityText(lr *logspb.LogRecord) string {
	if t := lr.GetSeverityText(); t != "" {
		return strings.ToUpper(t)
	}
	n := lr.GetSeverityNumber()
	switch {
	case n >= logspb.SeverityNumber_SEVERITY_NUMBER_ERROR:
		return "ERROR"
	case n >= logspb.SeverityNumber_SEVERITY_NUMBER_WARN:
		return "WARN"
	case n >= logspb.SeverityNumber_SEVERITY_NUMBER_INFO:
		return "INFO"
	case n >= logspb.SeverityNumber_SEVERITY_NUMBER_DEBUG:
		return "DEBUG"
	default:
		return "UNSET"
	}
}
