package gateway

import (
	"net/http"

	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"

	"github.com/heejune/apm/internal/buffer"
	"github.com/heejune/apm/internal/otlp"
)

const defaultTenant = "default"

// tenantFromReq routes ingest to a tenant via the X-APM-Tenant header (agents
// set it per deployment); falls back to the default tenant.
func tenantFromReq(r *http.Request) string {
	if t := r.Header.Get("X-APM-Tenant"); t != "" {
		return t
	}
	return defaultTenant
}

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
		spans := otlp.MapTraces(&req, tenantFromReq(r))
		if err := buf.Publish(r.Context(), spans); err != nil {
			http.Error(w, "publish failed", http.StatusServiceUnavailable)
			return
		}
		writeExportOK(w, r, &coltracepb.ExportTraceServiceResponse{})
	}
}
