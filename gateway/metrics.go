package gateway

import (
	"context"
	"io"
	"net/http"

	"google.golang.org/protobuf/proto"

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
		body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}
		var req colmetricspb.ExportMetricsServiceRequest
		if err := proto.Unmarshal(body, &req); err != nil {
			http.Error(w, "invalid protobuf", http.StatusBadRequest)
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
		resp, _ := proto.Marshal(&colmetricspb.ExportMetricsServiceResponse{})
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}
}
