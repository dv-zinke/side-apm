package main

import (
	"log"
	"net/http"
	"os"

	"github.com/heejune/apm/gateway"
	"github.com/heejune/apm/internal/buffer"
	"github.com/heejune/apm/internal/storage"
)

func main() {
	dsn := getenv("APM_CH_DSN", "clickhouse://localhost:9000/apm")
	store, err := storage.New(dsn)
	if err != nil {
		log.Fatalf("clickhouse: %v", err)
	}
	buf := &buffer.Direct{Store: store}

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/traces", gateway.TracesHandler(buf))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })

	addr := getenv("APM_GATEWAY_ADDR", ":4318")
	log.Printf("gateway listening on %s (OTLP/HTTP)", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
