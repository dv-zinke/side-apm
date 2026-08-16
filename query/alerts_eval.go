package query

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/heejune/apm/internal/storage"
)

// AlertStore is the subset of storage used by the evaluator.
type AlertStore interface {
	ListAlertRules(ctx context.Context, tenant string) ([]storage.AlertRule, error)
	InsertAlert(ctx context.Context, tenant string, a storage.Alert) error
	EvalServiceMetric(ctx context.Context, tenant, service, metric string, windowMin uint16) (float64, bool, error)
	ListMonitors(ctx context.Context, tenant string, from, to time.Time) ([]storage.MonitorStatus, error)
	ListAlerts(ctx context.Context, tenant string, limit int) ([]storage.Alert, error)
}

// Evaluator periodically checks alert rules and fires on breaches. It tracks
// per-rule state in-memory so it only fires on transitions (ok→firing) and
// records a resolved event on recovery — no alert spam.
type firingState struct {
	rule storage.AlertRule
	val  float64
}

type Evaluator struct {
	store      AlertStore
	interval   time.Duration
	webhookURL string
	mu         sync.Mutex
	firing     map[string]firingState // rule id -> last-firing snapshot
	monDown    map[string]bool        // monitor -> currently-down (transition tracking)
}

func NewEvaluator(store AlertStore, interval time.Duration, webhookURL string) *Evaluator {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	return &Evaluator{store: store, interval: interval, webhookURL: webhookURL, firing: map[string]firingState{}, monDown: map[string]bool{}}
}

func (e *Evaluator) Run(ctx context.Context) {
	e.restore(ctx)
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

// restore rebuilds in-memory firing state from the alerts table on startup so a
// query restart doesn't re-fire (and re-notify) alerts that are already active.
func (e *Evaluator) restore(ctx context.Context) {
	alerts, err := e.store.ListAlerts(ctx, defaultTenant, 500)
	if err != nil {
		return
	}
	seen := map[string]bool{}
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, a := range alerts { // newest first
		if seen[a.RuleID] {
			continue
		}
		seen[a.RuleID] = true
		if a.State != "firing" {
			continue
		}
		if mon, ok := strings.CutPrefix(a.RuleID, "synthetic:"); ok {
			e.monDown[mon] = true
		} else {
			e.firing[a.RuleID] = firingState{
				rule: storage.AlertRule{ID: a.RuleID, Name: a.RuleName, Service: a.Service, Metric: a.Metric, Threshold: a.Threshold},
				val:  a.Value,
			}
		}
	}
	if len(e.firing) > 0 || len(e.monDown) > 0 {
		log.Printf("alerts: restored %d firing rules + %d down monitors", len(e.firing), len(e.monDown))
	}
}

func (e *Evaluator) tick(ctx context.Context) {
	e.checkSynthetics(ctx)

	rules, err := e.store.ListAlertRules(ctx, defaultTenant)
	if err != nil {
		log.Printf("alerts: list rules: %v", err)
		return
	}
	// Track which rules still exist + are enabled this tick, so deleted/disabled
	// rules that were firing get auto-resolved instead of lingering forever.
	live := make(map[string]bool, len(rules))
	for _, r := range rules {
		if r.Enabled {
			live[r.ID] = true
		}
		if !r.Enabled {
			continue
		}
		val, ok, err := e.store.EvalServiceMetric(ctx, defaultTenant, r.Service, r.Metric, r.WindowMin)
		if err != nil || !ok {
			continue
		}
		breached := val > r.Threshold
		e.mu.Lock()
		_, was := e.firing[r.ID]
		e.mu.Unlock()

		if breached && !was {
			e.fire(ctx, r, val, "firing")
			e.mu.Lock()
			e.firing[r.ID] = firingState{rule: r, val: val}
			e.mu.Unlock()
		} else if !breached && was {
			e.fire(ctx, r, val, "resolved")
			e.mu.Lock()
			delete(e.firing, r.ID)
			e.mu.Unlock()
		} else if breached && was {
			e.mu.Lock()
			e.firing[r.ID] = firingState{rule: r, val: val}
			e.mu.Unlock()
		}
	}

	// Auto-resolve rules that vanished (deleted or disabled) while firing.
	e.mu.Lock()
	stale := make([]firingState, 0)
	for id, fs := range e.firing {
		if !live[id] {
			stale = append(stale, fs)
			delete(e.firing, id)
		}
	}
	e.mu.Unlock()
	for _, fs := range stale {
		e.fire(ctx, fs.rule, fs.val, "resolved")
	}
}

// checkSynthetics fires (and resolves) alerts when a synthetic monitor goes
// down — no rule config needed, an unreachable endpoint is inherently alertable.
func (e *Evaluator) checkSynthetics(ctx context.Context) {
	to := time.Now().UTC()
	monitors, err := e.store.ListMonitors(ctx, defaultTenant, to.Add(-90*time.Second), to)
	if err != nil {
		return
	}
	seen := make(map[string]storage.MonitorStatus, len(monitors))
	for _, m := range monitors {
		seen[m.Monitor] = m
		e.mu.Lock()
		wasDown := e.monDown[m.Monitor]
		e.mu.Unlock()
		if !m.Up && !wasDown {
			e.fireSynthetic(ctx, m, "firing")
			e.mu.Lock()
			e.monDown[m.Monitor] = true
			e.mu.Unlock()
		} else if m.Up && wasDown {
			e.fireSynthetic(ctx, m, "resolved")
			e.mu.Lock()
			delete(e.monDown, m.Monitor)
			e.mu.Unlock()
		}
	}
	// Auto-resolve monitors that dropped out of the window while marked down
	// (removed from config or no longer reporting) so alerts don't linger.
	e.mu.Lock()
	var vanished []string
	for name := range e.monDown {
		if _, ok := seen[name]; !ok {
			vanished = append(vanished, name)
		}
	}
	for _, name := range vanished {
		delete(e.monDown, name)
	}
	e.mu.Unlock()
	for _, name := range vanished {
		e.fireSynthetic(ctx, storage.MonitorStatus{Monitor: name, Uptime: 100}, "resolved")
	}
}

func (e *Evaluator) fireSynthetic(ctx context.Context, m storage.MonitorStatus, state string) {
	a := storage.Alert{
		FiredAt: time.Now().UTC(), RuleID: "synthetic:" + m.Monitor, RuleName: "가동 실패: " + m.Monitor,
		Service: m.Monitor, Metric: "uptime", Value: m.Uptime, Threshold: 100, State: state,
	}
	if err := e.store.InsertAlert(ctx, defaultTenant, a); err != nil {
		log.Printf("alerts: insert synthetic: %v", err)
	}
	if e.webhookURL != "" {
		icon := "🔴"
		verb := "다운"
		if state == "resolved" {
			icon, verb = "✅", "복구"
		}
		text := fmt.Sprintf("%s [%s] 가동 %s · %s (%s) · 업타임 %.1f%%", icon, state, verb, m.Monitor, m.URL, m.Uptime)
		e.postWebhook(text)
	}
	log.Printf("alerts: synthetic [%s] %s (%s)", state, m.Monitor, m.URL)
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
	e.postWebhook(text)
}

// postWebhook sends a Slack-compatible {"text":…} payload to the configured URL.
func (e *Evaluator) postWebhook(text string) {
	if e.webhookURL == "" {
		return
	}
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
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("alerts: webhook returned %d", resp.StatusCode)
	}
}
