package main

import (
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

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
	// Async batched ingest for every signal: absorb spikes, retry transient CH
	// failures, backpressure (503) when saturated so exporters retry.
	opts := buffer.Opts{
		QueueDepth: getenvInt("APM_INGEST_QUEUE", 1024),
		BatchMax:   getenvInt("APM_INGEST_BATCH", 2000),
		Flush:      time.Duration(getenvInt("APM_INGEST_FLUSH_MS", 500)) * time.Millisecond,
	}
	spanBuf := buffer.NewSpanBatcher(store, opts)
	metricBuf := buffer.NewBatcher("metrics", store.InsertMetrics, opts)
	histoBuf := buffer.NewBatcher("histograms", store.InsertHistograms, opts)
	logBuf := buffer.NewBatcher("logs", store.InsertLogs, opts)

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/traces", gateway.TracesHandler(spanBuf))
	mux.HandleFunc("/v1/metrics", gateway.MetricsHandler(metricBuf.Publish, histoBuf.Publish))
	mux.HandleFunc("/v1/logs", gateway.LogsHandler(logBuf.Publish))
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

func getenvInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
