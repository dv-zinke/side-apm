package query

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/heejune/apm/internal/storage"
)

// AlertStore is the subset of storage used by the evaluator.
type AlertStore interface {
	ListAlertRules(ctx context.Context, tenant string) ([]storage.AlertRule, error)
	InsertAlert(ctx context.Context, tenant string, a storage.Alert) error
	EvalServiceMetric(ctx context.Context, tenant, service, metric string, windowMin uint16) (float64, bool, error)
}

// Evaluator periodically checks alert rules and fires on breaches. It tracks
// per-rule state in-memory so it only fires on transitions (ok→firing) and
// records a resolved event on recovery — no alert spam.
type Evaluator struct {
	store      AlertStore
	interval   time.Duration
	webhookURL string
	mu         sync.Mutex
	firing     map[string]bool // rule id -> currently firing
}

func NewEvaluator(store AlertStore, interval time.Duration, webhookURL string) *Evaluator {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	return &Evaluator{store: store, interval: interval, webhookURL: webhookURL, firing: map[string]bool{}}
}

func (e *Evaluator) Run(ctx context.Context) {
	t := time.NewTicker(e.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			e.tick(ctx)
		}
	}
}

func (e *Evaluator) tick(ctx context.Context) {
	rules, err := e.store.ListAlertRules(ctx, defaultTenant)
	if err != nil {
		log.Printf("alerts: list rules: %v", err)
		return
	}
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		val, ok, err := e.store.EvalServiceMetric(ctx, defaultTenant, r.Service, r.Metric, r.WindowMin)
		if err != nil || !ok {
			continue
		}
		breached := val > r.Threshold
		e.mu.Lock()
		was := e.firing[r.ID]
		e.mu.Unlock()

		if breached && !was {
			e.fire(ctx, r, val, "firing")
			e.mu.Lock()
			e.firing[r.ID] = true
			e.mu.Unlock()
		} else if !breached && was {
			e.fire(ctx, r, val, "resolved")
			e.mu.Lock()
			e.firing[r.ID] = false
			e.mu.Unlock()
		}
	}
}

func (e *Evaluator) fire(ctx context.Context, r storage.AlertRule, val float64, state string) {
	a := storage.Alert{
		FiredAt: time.Now().UTC(), RuleID: r.ID, RuleName: r.Name, Service: r.Service,
		Metric: r.Metric, Value: val, Threshold: r.Threshold, State: state,
	}
	if err := e.store.InsertAlert(ctx, defaultTenant, a); err != nil {
		log.Printf("alerts: insert: %v", err)
	}
	e.notify(r, val, state)
}

// notify posts a Slack-compatible message when a webhook is configured.
func (e *Evaluator) notify(r storage.AlertRule, val float64, state string) {
	if e.webhookURL == "" {
		return
	}
	icon := "🔴"
	if state == "resolved" {
		icon = "✅"
	}
	unit := "%"
	if r.Metric == "p95_ms" {
		unit = "ms"
	}
	text := fmt.Sprintf("%s [%s] %s · %s = %.1f%s (임계 %.1f%s, 최근 %d분)",
		icon, state, r.Name, r.Service, val, unit, r.Threshold, unit, r.WindowMin)
	body, _ := json.Marshal(map[string]string{"text": text})
	req, err := http.NewRequest(http.MethodPost, e.webhookURL, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("alerts: webhook: %v", err)
		return
	}
	_ = resp.Body.Close()
}
