package gateway

import (
	"context"
	"io"
	"net/http"

	"google.golang.org/protobuf/proto"

	collogspb "go.opentelemetry.io/proto/otlp/collector/logs/v1"

	"github.com/heejune/apm/internal/otlp"
)

type LogsPublisher interface {
	InsertLogs(ctx context.Context, ls []otlp.LogRecord) error
}

func LogsHandler(pub LogsPublisher) http.HandlerFunc {
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
		var req collogspb.ExportLogsServiceRequest
		if err := proto.Unmarshal(body, &req); err != nil {
			http.Error(w, "invalid protobuf", http.StatusBadRequest)
			return
		}
		logs := otlp.MapLogs(&req, defaultTenant)
		if err := pub.InsertLogs(r.Context(), logs); err != nil {
			http.Error(w, "publish failed", http.StatusServiceUnavailable)
			return
		}
		resp, _ := proto.Marshal(&collogspb.ExportLogsServiceResponse{})
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}
}
