package gateway

import (
	"io"
	"net/http"

	"google.golang.org/protobuf/proto"

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
		body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20)) // 16MB 상한
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}
		var req coltracepb.ExportTraceServiceRequest
		if err := proto.Unmarshal(body, &req); err != nil {
			http.Error(w, "invalid protobuf", http.StatusBadRequest)
			return
		}
		spans := otlp.MapTraces(&req, defaultTenant)
		if err := buf.Publish(r.Context(), spans); err != nil {
			http.Error(w, "publish failed", http.StatusServiceUnavailable)
			return
		}
		// OTLP 성공 응답: 빈 ExportTraceServiceResponse
		resp, _ := proto.Marshal(&coltracepb.ExportTraceServiceResponse{})
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}
}
