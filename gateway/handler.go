package gateway

import (
	"net/http"

	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"

	"github.com/heejune/apm/internal/buffer"
	"github.com/heejune/apm/internal/otlp"
)

const defaultTenant = "default" // Phase 4에서 API key 기반으로 대체

func TracesHandler(buf buffer.Port) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req coltracepb.ExportTraceServiceRequest
		if err := readExport(r, &req); err != nil {
			http.Error(w, "invalid OTLP payload", http.StatusBadRequest)
			return
		}
		spans := otlp.MapTraces(&req, defaultTenant)
		if err := buf.Publish(r.Context(), spans); err != nil {
			http.Error(w, "publish failed", http.StatusServiceUnavailable)
			return
		}
		writeExportOK(w, r, &coltracepb.ExportTraceServiceResponse{})
	}
}
