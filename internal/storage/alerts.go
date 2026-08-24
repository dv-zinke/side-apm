package storage

import (
	"context"
	"strings"
	"time"
)

type AlertRule struct {
	ID        string
	Name      string
	Service   string
	Metric    string // error_rate | p95_ms | error_count | log_match
	Threshold float64
	WindowMin uint16
	Enabled   bool
	Channels  string // comma-separated channel ids ("" → global webhook fallback)
	Query     string // log-query DSL, for metric == "log_match"
	// Suppress notifications until this time (maintenance window). Zero/past =
	// active. The rule still evaluates and records firing history when snoozed.
	SnoozeUntil time.Time
}

// Snoozed reports whether the rule's notifications are currently silenced.
func (r AlertRule) Snoozed() bool { return r.SnoozeUntil.After(time.Now()) }

type Alert struct {
	FiredAt   time.Time
	RuleID    string
	RuleName  string
	Service   string
	Metric    string
	Value     float64
	Threshold float64
	State     string
}

func b2u(b bool) uint8 {
	if b {
		return 1
	}
	return 0
}

// UpsertAlertRule inserts/updates a rule (ReplacingMergeTree dedups by id).
func (s *Store) UpsertAlertRule(ctx context.Context, tenantID string, r AlertRule) error {
	snooze := r.SnoozeUntil
	if snooze.IsZero() {
		snooze = time.Unix(0, 0).UTC()
	}
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.alert_rules (tenant_id,id,name,service,metric,threshold,window_min,enabled,channels,query,snooze_until,deleted,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)",
		tenantID, r.ID, r.Name, r.Service, r.Metric, r.Threshold, r.WindowMin, b2u(r.Enabled), r.Channels, r.Query, snooze, time.Now().UTC(),
	)
	return err
}

func (s *Store) DeleteAlertRule(ctx context.Context, tenantID, id string) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.alert_rules (tenant_id,id,name,service,metric,threshold,window_min,enabled,channels,query,snooze_until,deleted,updated_at) VALUES (?,?,'','','',0,0,0,'','',toDateTime64(0,3),1,?)",
		tenantID, id, time.Now().UTC(),
	)
	return err
}

func (s *Store) ListAlertRules(ctx context.Context, tenantID string) ([]AlertRule, error) {
	const q = `
SELECT id, name, service, metric, threshold, window_min, enabled, channels, query, snooze_until
FROM apm.alert_rules FINAL
WHERE tenant_id = ? AND deleted = 0
ORDER BY name`
	rows, err := s.db.QueryContext(ctx, q, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AlertRule
	for rows.Next() {
		var r AlertRule
		var en uint8
		if err := rows.Scan(&r.ID, &r.Name, &r.Service, &r.Metric, &r.Threshold, &r.WindowMin, &en, &r.Channels, &r.Query, &r.SnoozeUntil); err != nil {
			return nil, err
		}
		r.Enabled = en == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) InsertAlert(ctx context.Context, tenantID string, a Alert) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.alerts (tenant_id,fired_at,rule_id,rule_name,service,metric,value,threshold,state) VALUES (?,?,?,?,?,?,?,?,?)",
		tenantID, a.FiredAt, a.RuleID, a.RuleName, a.Service, a.Metric, a.Value, a.Threshold, a.State,
	)
	return err
}

func (s *Store) ListAlerts(ctx context.Context, tenantID string, limit int) ([]Alert, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	const q = `
SELECT fired_at, rule_id, rule_name, service, metric, value, threshold, state
FROM apm.alerts
WHERE tenant_id = ?
ORDER BY fired_at DESC
LIMIT ?`
	rows, err := s.db.QueryContext(ctx, q, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Alert
	for rows.Next() {
		var a Alert
		if err := rows.Scan(&a.FiredAt, &a.RuleID, &a.RuleName, &a.Service, &a.Metric, &a.Value, &a.Threshold, &a.State); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// EvalServiceMetric computes the current value of a rule's metric over its
// window, from the RED rollup. Returns (value, hasData).
func (s *Store) EvalServiceMetric(ctx context.Context, tenantID, service, metric string, windowMin uint16) (float64, bool, error) {
	if windowMin == 0 {
		windowMin = 5
	}
	from := time.Now().UTC().Add(-time.Duration(windowMin) * time.Minute)
	pts, err := s.GetServiceRED(ctx, tenantID, service, from, time.Now().UTC())
	if err != nil {
		return 0, false, err
	}
	if len(pts) == 0 {
		return 0, false, nil
	}
	switch metric {
	case "error_rate":
		var req, errs uint64
		for _, p := range pts {
			req += p.RequestCount
			errs += p.ErrorCount
		}
		if req == 0 {
			return 0, false, nil
		}
		return float64(errs) / float64(req) * 100, true, nil
	case "p95_ms":
		var max float64
		for _, p := range pts {
			if p.P95Ms > max {
				max = p.P95Ms
			}
		}
		return max, true, nil
	case "error_count":
		var errs uint64
		for _, p := range pts {
			errs += p.ErrorCount
		}
		return float64(errs), true, nil
	default:
		return 0, false, nil
	}
}

// CountLogMatches counts logs matching a log-query DSL over the window — the
// value behind a "log_match" alert rule. Reuses the safe log-query compiler.
func (s *Store) CountLogMatches(ctx context.Context, tenantID, dsl string, windowMin uint16) (float64, bool, error) {
	if windowMin == 0 {
		windowMin = 5
	}
	where, wargs, err := buildLogWhere(strings.TrimSpace(dsl))
	if err != nil {
		return 0, false, err
	}
	from := time.Now().UTC().Add(-time.Duration(windowMin) * time.Minute)
	q := "SELECT count() FROM apm.logs WHERE tenant_id = ? AND ts >= ? AND ts <= ? AND " + where + " SETTINGS max_execution_time = 10"
	args := append([]any{tenantID, from, time.Now().UTC()}, wargs...)
	var n uint64
	if err := s.db.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
		return 0, false, err
	}
	return float64(n), true, nil
}
