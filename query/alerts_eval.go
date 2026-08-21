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
	CountLogMatches(ctx context.Context, tenant, dsl string, windowMin uint16) (float64, bool, error)
	ListMonitors(ctx context.Context, tenant string, from, to time.Time) ([]storage.MonitorStatus, error)
	ListAlerts(ctx context.Context, tenant string, limit int) ([]storage.Alert, error)
	ListServices(ctx context.Context, tenant string) ([]string, error)
	GetServiceRED(ctx context.Context, tenant, service string, from, to time.Time) ([]storage.REDPoint, error)
	ListTenants(ctx context.Context) ([]string, error)
	ListChannels(ctx context.Context, tenant string) ([]storage.AlertChannel, error)
	InsertNotification(ctx context.Context, tenant string, n storage.Notification) error
}

// tenant-scoped state key so one tenant's transitions never collide with another's.
func tkey(tenant, id string) string { return tenant + "\x00" + id }

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
	anomActive map[string]Anomaly     // "service:metric" -> current anomaly (transition tracking)
}

func NewEvaluator(store AlertStore, interval time.Duration, webhookURL string) *Evaluator {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	return &Evaluator{store: store, interval: interval, webhookURL: webhookURL, firing: map[string]firingState{}, monDown: map[string]bool{}, anomActive: map[string]Anomaly{}}
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
	tenants, err := e.store.ListTenants(ctx)
	if err != nil || len(tenants) == 0 {
		tenants = []string{defaultTenant}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, tenant := range tenants {
		alerts, err := e.store.ListAlerts(ctx, tenant, 500)
		if err != nil {
			continue
		}
		// Latest state per rule; on an equal timestamp prefer "resolved" so we
		// never restore a firing that already recovered.
		latest := map[string]storage.Alert{}
		for _, a := range alerts {
			cur, ok := latest[a.RuleID]
			if !ok || a.FiredAt.After(cur.FiredAt) || (a.FiredAt.Equal(cur.FiredAt) && a.State == "resolved") {
				latest[a.RuleID] = a
			}
		}
		for _, a := range latest {
			if a.State != "firing" {
				continue
			}
			if mon, ok := strings.CutPrefix(a.RuleID, "synthetic:"); ok {
				e.monDown[tkey(tenant, mon)] = true
			} else if strings.HasPrefix(a.RuleID, "anomaly:") {
				e.anomActive[tkey(tenant, a.Service+":"+a.Metric)] = Anomaly{Service: a.Service, Metric: a.Metric, Current: a.Value, Baseline: a.Threshold}
			} else {
				e.firing[tkey(tenant, a.RuleID)] = firingState{
					rule: storage.AlertRule{ID: a.RuleID, Name: a.RuleName, Service: a.Service, Metric: a.Metric, Threshold: a.Threshold},
					val:  a.Value,
				}
			}
		}
	}
	if len(e.firing) > 0 || len(e.monDown) > 0 || len(e.anomActive) > 0 {
		log.Printf("alerts: restored %d firing rules + %d down monitors + %d anomalies across %d tenants", len(e.firing), len(e.monDown), len(e.anomActive), len(tenants))
	}
}

func (e *Evaluator) tick(ctx context.Context) {
	tenants, err := e.store.ListTenants(ctx)
	if err != nil || len(tenants) == 0 {
		tenants = []string{defaultTenant}
	}
	for _, tenant := range tenants {
		e.checkSynthetics(ctx, tenant)
		e.checkAnomalies(ctx, tenant)
		e.evalRules(ctx, tenant)
	}
}

// evalRules checks one tenant's service-metric rules and fires/resolves on
// transition. State is keyed by (tenant, rule) so tenants don't collide.
func (e *Evaluator) evalRules(ctx context.Context, tenant string) {
	rules, err := e.store.ListAlertRules(ctx, tenant)
	if err != nil {
		log.Printf("alerts: list rules (%s): %v", tenant, err)
		return
	}
	live := make(map[string]bool, len(rules))
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		live[r.ID] = true
		var val float64
		var ok bool
		var err error
		if r.Metric == "log_match" {
			val, ok, err = e.store.CountLogMatches(ctx, tenant, r.Query, r.WindowMin)
		} else {
			val, ok, err = e.store.EvalServiceMetric(ctx, tenant, r.Service, r.Metric, r.WindowMin)
		}
		if err != nil || !ok {
			continue
		}
		breached := val > r.Threshold
		k := tkey(tenant, r.ID)
		e.mu.Lock()
		_, was := e.firing[k]
		e.mu.Unlock()

		if breached && !was {
			e.fire(ctx, tenant, r, val, "firing")
			e.mu.Lock()
			e.firing[k] = firingState{rule: r, val: val}
			e.mu.Unlock()
		} else if !breached && was {
			e.fire(ctx, tenant, r, val, "resolved")
			e.mu.Lock()
			delete(e.firing, k)
			e.mu.Unlock()
		} else if breached && was {
			e.mu.Lock()
			e.firing[k] = firingState{rule: r, val: val}
			e.mu.Unlock()
		}
	}

	// Auto-resolve this tenant's rules that vanished (deleted/disabled) while firing.
	prefix := tenant + "\x00"
	e.mu.Lock()
	var stale []firingState
	for k, fs := range e.firing {
		if strings.HasPrefix(k, prefix) && !live[strings.TrimPrefix(k, prefix)] {
			stale = append(stale, fs)
			delete(e.firing, k)
		}
	}
	e.mu.Unlock()
	for _, fs := range stale {
		e.fire(ctx, tenant, fs.rule, fs.val, "resolved")
	}
}

// checkSynthetics fires (and resolves) alerts when a synthetic monitor goes
// down — no rule config needed, an unreachable endpoint is inherently alertable.
func (e *Evaluator) checkSynthetics(ctx context.Context, tenant string) {
	to := time.Now().UTC()
	monitors, err := e.store.ListMonitors(ctx, tenant, to.Add(-90*time.Second), to)
	if err != nil {
		return
	}
	seen := make(map[string]storage.MonitorStatus, len(monitors))
	for _, m := range monitors {
		seen[m.Monitor] = m
		k := tkey(tenant, m.Monitor)
		e.mu.Lock()
		wasDown := e.monDown[k]
		e.mu.Unlock()
		if !m.Up && !wasDown {
			e.fireSynthetic(ctx, tenant, m, "firing")
			e.mu.Lock()
			e.monDown[k] = true
			e.mu.Unlock()
		} else if m.Up && wasDown {
			e.fireSynthetic(ctx, tenant, m, "resolved")
			e.mu.Lock()
			delete(e.monDown, k)
			e.mu.Unlock()
		}
	}
	// Auto-resolve this tenant's monitors that dropped out of the window.
	prefix := tenant + "\x00"
	e.mu.Lock()
	var vanished []string
	for k := range e.monDown {
		if strings.HasPrefix(k, prefix) && seen[strings.TrimPrefix(k, prefix)].Monitor == "" {
			vanished = append(vanished, k)
		}
	}
	for _, k := range vanished {
		delete(e.monDown, k)
	}
	e.mu.Unlock()
	for _, k := range vanished {
		e.fireSynthetic(ctx, tenant, storage.MonitorStatus{Monitor: strings.TrimPrefix(k, prefix), Uptime: 100}, "resolved")
	}
}

// checkAnomalies scans services for z-score anomalies and fires/resolves alerts
// on transitions — making anomaly detection actionable (on-call), not just a view.
func (e *Evaluator) checkAnomalies(ctx context.Context, tenant string) {
	services, err := e.store.ListServices(ctx, tenant)
	if err != nil {
		return
	}
	to := time.Now().UTC()
	from := to.Add(-60 * time.Minute)
	// Scan services concurrently so the anomaly pass doesn't push the tick past
	// its interval as the fleet grows.
	current := map[string]Anomaly{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, svc := range services {
		wg.Add(1)
		go func(svc string) {
			defer wg.Done()
			red, err := e.store.GetServiceRED(ctx, tenant, svc, from, to)
			if err != nil || len(red) < 12 {
				return
			}
			var p95, errRate, thr []float64
			for _, p := range red {
				p95 = append(p95, p.P95Ms)
				er := 0.0
				if p.RequestCount > 0 {
					er = 100 * float64(p.ErrorCount) / float64(p.RequestCount)
				}
				errRate = append(errRate, er)
				thr = append(thr, float64(p.RequestCount))
			}
			mu.Lock()
			defer mu.Unlock()
			if a, ok := detect(svc, "p95_ms", p95, 300, 0.5, false); ok {
				current[tkey(tenant, svc+":p95_ms")] = a
			}
			if a, ok := detect(svc, "error_rate", errRate, 1, 0.5, false); ok {
				current[tkey(tenant, svc+":error_rate")] = a
			}
			if a, ok := detect(svc, "throughput", thr, 5, 0.3, true); ok {
				current[tkey(tenant, svc+":throughput")] = a
			}
		}(svc)
	}
	wg.Wait()

	prefix := tenant + "\x00"
	e.mu.Lock()
	var toFire, toResolve []Anomaly
	for key, a := range current {
		if _, was := e.anomActive[key]; !was {
			toFire = append(toFire, a)
		}
		e.anomActive[key] = a
	}
	for key, a := range e.anomActive {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		if _, still := current[key]; !still {
			toResolve = append(toResolve, a)
			delete(e.anomActive, key)
		}
	}
	e.mu.Unlock()

	for _, a := range toFire {
		e.fireAnomaly(ctx, tenant, a, "firing")
	}
	for _, a := range toResolve {
		e.fireAnomaly(ctx, tenant, a, "resolved")
	}
}

func (e *Evaluator) fireAnomaly(ctx context.Context, tenant string, a Anomaly, state string) {
	al := storage.Alert{
		FiredAt: time.Now().UTC(), RuleID: "anomaly:" + a.Service + ":" + a.Metric,
		RuleName: "이상 감지: " + a.Service + " " + a.Metric, Service: a.Service,
		Metric: a.Metric, Value: a.Current, Threshold: a.Baseline, State: state,
	}
	if err := e.store.InsertAlert(ctx, tenant, al); err != nil {
		log.Printf("alerts: insert anomaly: %v", err)
	}
	verb := "이상 급변"
	if state == "resolved" {
		verb = "이상 해소"
	}
	text := fmt.Sprintf("%s [%s] %s · %s %s = %.1f (평소 %.1f, %.1fσ)",
		stateIcon(state), state, verb, a.Service, a.Metric, a.Current, a.Baseline, a.Z)
	// Auto-detected → broadcast to every enabled channel (nil).
	e.dispatch(ctx, tenant, notifMeta{al.RuleID, al.RuleName, state, text}, nil)
	log.Printf("alerts: anomaly [%s] %s %s (%.1fσ)", state, a.Service, a.Metric, a.Z)
}

func (e *Evaluator) fireSynthetic(ctx context.Context, tenant string, m storage.MonitorStatus, state string) {
	a := storage.Alert{
		FiredAt: time.Now().UTC(), RuleID: "synthetic:" + m.Monitor, RuleName: "가동 실패: " + m.Monitor,
		Service: m.Monitor, Metric: "uptime", Value: m.Uptime, Threshold: 100, State: state,
	}
	if err := e.store.InsertAlert(ctx, tenant, a); err != nil {
		log.Printf("alerts: insert synthetic: %v", err)
	}
	verb := "다운"
	if state == "resolved" {
		verb = "복구"
	}
	text := fmt.Sprintf("%s [%s] 가동 %s · %s (%s) · 업타임 %.1f%%", stateIcon(state), state, verb, m.Monitor, m.URL, m.Uptime)
	e.dispatch(ctx, tenant, notifMeta{a.RuleID, a.RuleName, state, text}, nil)
	log.Printf("alerts: synthetic [%s] %s (%s)", state, m.Monitor, m.URL)
}

func (e *Evaluator) fire(ctx context.Context, tenant string, r storage.AlertRule, val float64, state string) {
	a := storage.Alert{
		FiredAt: time.Now().UTC(), RuleID: r.ID, RuleName: r.Name, Service: r.Service,
		Metric: r.Metric, Value: val, Threshold: r.Threshold, State: state,
	}
	if err := e.store.InsertAlert(ctx, tenant, a); err != nil {
		log.Printf("alerts: insert: %v", err)
	}
	unit, subject := "%", r.Service
	switch r.Metric {
	case "p95_ms":
		unit = "ms"
	case "error_count":
		unit = "건"
	case "log_match":
		unit, subject = "건", "로그 "+r.Query
	}
	text := fmt.Sprintf("%s [%s] %s · %s = %.0f%s (임계 %.0f%s, 최근 %d분)",
		stateIcon(state), state, r.Name, subject, val, unit, r.Threshold, unit, r.WindowMin)
	// A rule routes to its assigned channels; with none, it falls back to the
	// global env webhook (back-compat). splitChannels("") → empty (not nil).
	e.dispatch(ctx, tenant, notifMeta{r.ID, r.Name, state, text}, splitChannels(r.Channels))
}

func stateIcon(state string) string {
	if state == "resolved" {
		return "✅"
	}
	return "🔴"
}

// splitChannels turns "a, b" into ["a","b"]; "" into a non-nil empty slice so a
// no-channel rule can be told apart from a broadcast (nil).
func splitChannels(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

type notifMeta struct {
	ruleID, ruleName, state, text string
}

// dispatch delivers one alert to its destinations and logs each attempt.
// channelIDs == nil  → broadcast to every enabled channel (auto-alerts).
// channelIDs == []   → no per-rule channels → fall back to the global webhook.
// channelIDs == [..] → exactly those channels.
func (e *Evaluator) dispatch(ctx context.Context, tenant string, m notifMeta, channelIDs []string) {
	channels, err := e.store.ListChannels(ctx, tenant)
	if err != nil {
		log.Printf("alerts: list channels: %v", err)
	}
	byID := map[string]storage.AlertChannel{}
	var enabled []storage.AlertChannel
	for _, c := range channels {
		if c.Enabled {
			byID[c.ID] = c
			enabled = append(enabled, c)
		}
	}
	var targets []storage.AlertChannel
	if channelIDs == nil {
		targets = enabled
	} else {
		for _, id := range channelIDs {
			if c, ok := byID[id]; ok {
				targets = append(targets, c)
			}
		}
	}
	// Fall back to the global env webhook when a rule has no live channels.
	if len(targets) == 0 {
		if e.webhookURL != "" {
			err := postJSON(e.webhookURL, map[string]string{"text": m.text})
			e.logNotif(ctx, tenant, m, "", "환경 웹훅", "slack", err)
		}
		return
	}
	for _, c := range targets {
		err := sendToChannel(c, m)
		e.logNotif(ctx, tenant, m, c.ID, c.Name, c.Type, err)
	}
}

func (e *Evaluator) logNotif(ctx context.Context, tenant string, m notifMeta, chID, chName, chType string, sendErr error) {
	n := storage.Notification{
		Ts: time.Now().UTC(), RuleID: m.ruleID, RuleName: m.ruleName,
		ChannelID: chID, ChannelName: chName, Type: chType, State: m.state, OK: sendErr == nil,
	}
	if sendErr != nil {
		n.Error = sendErr.Error()
		log.Printf("alerts: notify %s via %s: %v", m.ruleName, chName, sendErr)
	}
	if err := e.store.InsertNotification(ctx, tenant, n); err != nil {
		log.Printf("alerts: log notification: %v", err)
	}
}

// sendToChannel formats the alert for the channel's provider and posts it.
func sendToChannel(c storage.AlertChannel, m notifMeta) error {
	switch c.Type {
	case "pagerduty":
		action := "trigger"
		severity := "error"
		if m.state == "resolved" {
			action, severity = "resolve", "info"
		}
		return postJSON("https://events.pagerduty.com/v2/enqueue", map[string]any{
			"routing_key":  c.Target,
			"event_action": action,
			"dedup_key":    m.ruleID,
			"payload": map[string]any{
				"summary": m.text, "severity": severity, "source": "apm", "component": m.ruleName,
			},
		})
	case "webhook":
		return postJSON(c.Target, map[string]any{
			"rule": m.ruleName, "state": m.state, "message": m.text,
		})
	default: // slack (Slack-compatible incoming webhook)
		return postJSON(c.Target, map[string]string{"text": m.text})
	}
}

// postJSON POSTs a JSON body and treats any non-2xx/3xx as an error.
func postJSON(url string, payload any) error {
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}
