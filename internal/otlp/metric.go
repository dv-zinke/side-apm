package otlp

import (
	"time"

	colmetricspb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	metricspb "go.opentelemetry.io/proto/otlp/metrics/v1"
)

type Metric struct {
	TenantID    string
	ServiceName string
	Name        string
	Unit        string
	Time        time.Time
	Value       float64
	Attrs       map[string]string
}

func numberValue(dp *metricspb.NumberDataPoint) (float64, bool) {
	switch v := dp.GetValue().(type) {
	case *metricspb.NumberDataPoint_AsDouble:
		return v.AsDouble, true
	case *metricspb.NumberDataPoint_AsInt:
		return float64(v.AsInt), true
	default:
		return 0, false
	}
}

// MapMetrics flattens OTLP Gauge and Sum number data points into rows.
// Histograms/summaries are skipped for now (runtime metrics are gauges/sums).
func MapMetrics(req *colmetricspb.ExportMetricsServiceRequest, tenantID string) []Metric {
	var out []Metric
	for _, rm := range req.GetResourceMetrics() {
		res := attrMap(rm.GetResource().GetAttributes())
		service := res["service.name"]
		for _, sm := range rm.GetScopeMetrics() {
			for _, m := range sm.GetMetrics() {
				var dps []*metricspb.NumberDataPoint
				switch d := m.GetData().(type) {
				case *metricspb.Metric_Gauge:
					dps = d.Gauge.GetDataPoints()
				case *metricspb.Metric_Sum:
					dps = d.Sum.GetDataPoints()
				default:
					continue
				}
				for _, dp := range dps {
					val, ok := numberValue(dp)
					if !ok {
						continue
					}
					out = append(out, Metric{
						TenantID:    tenantID,
						ServiceName: service,
						Name:        m.GetName(),
						Unit:        m.GetUnit(),
						Time:        time.Unix(0, int64(dp.GetTimeUnixNano())).UTC(),
						Value:       val,
						Attrs:       attrMap(dp.GetAttributes()),
					})
				}
			}
		}
	}
	return out
}
