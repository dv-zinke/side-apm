package query

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type AlertRuleDTO struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Service   string   `json:"service"`
	Metric    string   `json:"metric"` // error_rate | p95_ms | error_count | log_match
	Threshold float64  `json:"threshold"`
	WindowMin int      `json:"windowMin"`
	Enabled   bool     `json:"enabled"`
	Channels    []string `json:"channels"`
	Query       string   `json:"query"`       // log-query DSL, for metric == "log_match"
	SnoozeUntil string   `json:"snoozeUntil"` // RFC3339, "" = active
}

var validAlertMetric = map[string]bool{"error_rate": true, "p95_ms": true, "error_count": true, "log_match": true}

func splitCSV(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

type AlertDTO struct {
	FiredAt   string  `json:"firedAt"`
	RuleID    string  `json:"ruleId"`
	RuleName  string  `json:"ruleName"`
	Service   string  `json:"service"`
	Metric    string  `json:"metric"`
	Value     float64 `json:"value"`
	Threshold float64 `json:"threshold"`
	State     string  `json:"state"`
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func registerAlerts(mux *http.ServeMux, r Reader) {
	mux.HandleFunc("GET /api/v1/alert-rules", func(w http.ResponseWriter, req *http.Request) {
		rules, err := r.ListAlertRules(req.Context(), tenantOf(req))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]AlertRuleDTO, 0, len(rules))
		for _, x := range rules {
			snooze := ""
			if x.SnoozeUntil.After(time.Now()) {
				snooze = x.SnoozeUntil.UTC().Format(time.RFC3339)
			}
			out = append(out, AlertRuleDTO{x.ID, x.Name, x.Service, x.Metric, x.Threshold, int(x.WindowMin), x.Enabled, splitCSV(x.Channels), x.Query, snooze})
		}
		writeJSON(w, out)
	})

	mux.HandleFunc("POST /api/v1/alert-rules", func(w http.ResponseWriter, req *http.Request) {
		var dto AlertRuleDTO
		if err := json.NewDecoder(req.Body).Decode(&dto); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if dto.Name == "" || !validAlertMetric[dto.Metric] {
			http.Error(w, "name, metric(error_rate|p95_ms|error_count|log_match) required", http.StatusBadRequest)
			return
		}
		// log_match rules target a query, not a service; the others need a service.
		if dto.Metric == "log_match" {
			if dto.Query == "" {
				http.Error(w, "log_match rule requires query", http.StatusBadRequest)
				return
			}
		} else if dto.Service == "" {
			http.Error(w, "service required", http.StatusBadRequest)
			return
		}
		if dto.ID == "" {
			dto.ID = newID()
		}
		if dto.WindowMin <= 0 {
			dto.WindowMin = 5
		}
		var snooze time.Time
		if dto.SnoozeUntil != "" {
			if t, err := time.Parse(time.RFC3339, dto.SnoozeUntil); err == nil {
				snooze = t
			}
		}
		if err := r.UpsertAlertRule(req.Context(), tenantOf(req), storage.AlertRule{
			ID: dto.ID, Name: dto.Name, Service: dto.Service, Metric: dto.Metric,
			Threshold: dto.Threshold, WindowMin: uint16(dto.WindowMin), Enabled: dto.Enabled,
			Channels: strings.Join(dto.Channels, ","), Query: dto.Query, SnoozeUntil: snooze,
		}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, dto)
	})

	mux.HandleFunc("DELETE /api/v1/alert-rules/{id}", func(w http.ResponseWriter, req *http.Request) {
		if err := r.DeleteAlertRule(req.Context(), tenantOf(req), req.PathValue("id")); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("GET /api/v1/alerts", func(w http.ResponseWriter, req *http.Request) {
		limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
		alerts, err := r.ListAlerts(req.Context(), tenantOf(req), limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]AlertDTO, 0, len(alerts))
		for _, a := range alerts {
			out = append(out, AlertDTO{
				FiredAt: a.FiredAt.Format(time.RFC3339), RuleID: a.RuleID, RuleName: a.RuleName,
				Service: a.Service, Metric: a.Metric, Value: a.Value, Threshold: a.Threshold, State: a.State,
			})
		}
		writeJSON(w, out)
	})
}
