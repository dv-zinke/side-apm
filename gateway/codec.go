package gateway

import (
	"io"
	"net/http"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func isJSON(ct string) bool { return strings.Contains(ct, "application/json") }

// readExport unmarshals an OTLP request body as protobuf or JSON, selected by
// Content-Type. Supporting JSON lets a vibe-coder POST with a plain `curl -d`
// and no SDK — the last mile of the one-line onboarding story.
func readExport(r *http.Request, msg proto.Message) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20)) // 16MB cap
	if err != nil {
		return err
	}
	if isJSON(r.Header.Get("Content-Type")) {
		return protojson.Unmarshal(body, msg)
	}
	return proto.Unmarshal(body, msg)
}

// writeExportOK returns the OTLP success response in the caller's format.
func writeExportOK(w http.ResponseWriter, r *http.Request, msg proto.Message) {
	if isJSON(r.Header.Get("Content-Type")) {
		b, _ := protojson.Marshal(msg)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(b)
		return
	}
	b, _ := proto.Marshal(msg)
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}
