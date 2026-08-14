package query

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type AlertRuleDTO struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Service   string  `json:"service"`
	Metric    string  `json:"metric"`    // error_rate | p95_ms
	Threshold float64 `json:"threshold"`
	WindowMin int     `json:"windowMin"`
	Enabled   bool    `json:"enabled"`
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
		rules, err := r.ListAlertRules(req.Context(), defaultTenant)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]AlertRuleDTO, 0, len(rules))
		for _, x := range rules {
			out = append(out, AlertRuleDTO{x.ID, x.Name, x.Service, x.Metric, x.Threshold, int(x.WindowMin), x.Enabled})
		}
		writeJSON(w, out)
	})

	mux.HandleFunc("POST /api/v1/alert-rules", func(w http.ResponseWriter, req *http.Request) {
		var dto AlertRuleDTO
		if err := json.NewDecoder(req.Body).Decode(&dto); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if dto.Name == "" || dto.Service == "" || (dto.Metric != "error_rate" && dto.Metric != "p95_ms") {
			http.Error(w, "name, service, metric(error_rate|p95_ms) required", http.StatusBadRequest)
			return
		}
		if dto.ID == "" {
			dto.ID = newID()
		}
		if dto.WindowMin <= 0 {
			dto.WindowMin = 5
		}
		if err := r.UpsertAlertRule(req.Context(), defaultTenant, storage.AlertRule{
			ID: dto.ID, Name: dto.Name, Service: dto.Service, Metric: dto.Metric,
			Threshold: dto.Threshold, WindowMin: uint16(dto.WindowMin), Enabled: dto.Enabled,
		}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, dto)
	})

	mux.HandleFunc("DELETE /api/v1/alert-rules/{id}", func(w http.ResponseWriter, req *http.Request) {
		if err := r.DeleteAlertRule(req.Context(), defaultTenant, req.PathValue("id")); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("GET /api/v1/alerts", func(w http.ResponseWriter, req *http.Request) {
		limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
		alerts, err := r.ListAlerts(req.Context(), defaultTenant, limit)
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
