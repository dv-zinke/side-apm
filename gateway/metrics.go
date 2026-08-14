package gateway

import (
	"context"
	"net/http"

	colmetricspb "go.opentelemetry.io/proto/otlp/collector/metrics/v1"

	"github.com/heejune/apm/internal/otlp"
)

// Publishers are batchers (or direct inserters) for each metric shape.
func MetricsHandler(
	publishMetrics func(ctx context.Context, ms []otlp.Metric) error,
	publishHistograms func(ctx context.Context, hs []otlp.Histogram) error,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req colmetricspb.ExportMetricsServiceRequest
		if err := readExport(r, &req); err != nil {
			http.Error(w, "invalid OTLP payload", http.StatusBadRequest)
			return
		}
		metrics := otlp.MapMetrics(&req, defaultTenant)
		if err := publishMetrics(r.Context(), metrics); err != nil {
			http.Error(w, "publish failed", http.StatusServiceUnavailable)
			return
		}
		if hs := otlp.MapHistograms(&req, defaultTenant); len(hs) > 0 {
			if err := publishHistograms(r.Context(), hs); err != nil {
				http.Error(w, "publish failed", http.StatusServiceUnavailable)
				return
			}
		}
		writeExportOK(w, r, &colmetricspb.ExportMetricsServiceResponse{})
	}
}
