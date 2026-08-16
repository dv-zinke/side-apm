package main

import (
	"context"
	"log"
	"net/http"
	"os"

	"github.com/heejune/apm/internal/storage"
	"github.com/heejune/apm/query"
)

func main() {
	dsn := getenv("APM_CH_DSN", "clickhouse://localhost:9000/apm")
	store, err := storage.New(dsn)
	if err != nil {
		log.Fatalf("clickhouse: %v", err)
	}

	// Background alert evaluator: checks rules on an interval, fires on breach,
	// optional Slack-compatible webhook via APM_ALERT_WEBHOOK.
	webhook := os.Getenv("APM_ALERT_WEBHOOK")
	if webhook != "" {
		log.Printf("alerts: webhook delivery enabled")
	} else {
		log.Printf("alerts: webhook delivery disabled (set APM_ALERT_WEBHOOK)")
	}
	eval := query.NewEvaluator(store, 0, webhook)
	go eval.Run(context.Background())

	addr := getenv("APM_QUERY_ADDR", ":8080")
	log.Printf("query service listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, query.Router(store)))
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
