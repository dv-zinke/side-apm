package main

import (
	"context"
	"log"
	"net/http"
	_ "net/http/pprof"
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

	// Seed default console users (admin/admin, viewer/viewer) on first boot.
	if err := store.SeedDefaultUsers(context.Background()); err != nil {
		log.Printf("users: seed: %v", err)
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

	// Synthetic uptime prober — probes monitors from APM_SYNTHETICS
	// ("name|url,name|url") or a default local+external set.
	prober := query.NewSyntheticProber(store, query.ParseMonitors(os.Getenv("APM_SYNTHETICS")), 0)
	go prober.Run(context.Background())

	// pprof endpoint + continuous profiler scraping the Go services.
	go func() { log.Println(http.ListenAndServe("0.0.0.0:6060", nil)) }()
	profiler := query.NewProfiler(store, query.ParseProfileTargets(os.Getenv("APM_PROFILE_TARGETS")), 0)
	go profiler.Run(context.Background())

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
