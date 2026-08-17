package query

import (
	"net/http"
	"strconv"
	"time"
)

type SLOStatus struct {
	Service         string  `json:"service"`
	WindowHours     int     `json:"windowHours"`
	TotalReq        uint64  `json:"totalReq"`
	TotalErr        uint64  `json:"totalErr"`
	SuccessRate     float64 `json:"successRate"`
	Target          float64 `json:"target"`
	BudgetConsumed  float64 `json:"budgetConsumed"`  // % of the error budget used
	BudgetRemaining float64 `json:"budgetRemaining"` // %
	P95Ms           float64 `json:"p95Ms"`
	HasLatency      bool    `json:"hasLatency"`
	AvailStatus     string  `json:"availStatus"`   // availability SLI
	LatencyStatus   string  `json:"latencyStatus"` // latency SLI (p95)
	Status          string  `json:"status"`        // worst of the two
}

var sloRank = map[string]int{"healthy": 0, "at_risk": 1, "breached": 2}

func worstStatus(a, b string) string {
	if sloRank[b] > sloRank[a] {
		return b
	}
	return a
}

func registerSLO(mux *http.ServeMux, r Reader) {
	// Availability SLOs with error budgets — the classic SRE artifact, computed
	// from RED over the window against a 99.9% target. Apdex rides along as the
	// latency SLI. Read-only: sensible default target, no config needed.
	mux.HandleFunc("GET /api/v1/slo", func(w http.ResponseWriter, req *http.Request) {
		ctx := req.Context()
		windowHours, _ := strconv.Atoi(req.URL.Query().Get("windowHours"))
		if windowHours <= 0 {
			windowHours = 24
		}
		target := 99.9
		if t, err := strconv.ParseFloat(req.URL.Query().Get("target"), 64); err == nil && t > 0 && t < 100 {
			target = t
		}
		to := time.Now().UTC()
		from := to.Add(-time.Duration(windowHours) * time.Hour)

		// The entire SLO view is now ONE aggregate query (availability + p95 per
		// service) — no per-service loop, no Apdex fan-out. Fast under load.
		avails, err := r.ServiceAvailabilities(ctx, tenantOf(req), from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		res := make([]SLOStatus, 0, len(avails))
		for _, a := range avails {
			if a.TotalReq == 0 {
				continue
			}
			success := 100 * float64(a.TotalReq-a.TotalErr) / float64(a.TotalReq)
			budget := 100 - target // allowed error %
			errPct := 100 * float64(a.TotalErr) / float64(a.TotalReq)
			consumed := 0.0
			if budget > 0 {
				consumed = 100 * errPct / budget
			}
			s := SLOStatus{
				Service: a.Service, WindowHours: windowHours, TotalReq: a.TotalReq, TotalErr: a.TotalErr,
				SuccessRate: success, Target: target, BudgetConsumed: consumed, BudgetRemaining: 100 - consumed,
				P95Ms: a.P95Ms, HasLatency: a.P95Ms > 0,
			}
			if s.BudgetRemaining < 0 {
				s.BudgetRemaining = 0
			}
			switch {
			case success < target:
				s.AvailStatus = "breached"
			case consumed >= 50:
				s.AvailStatus = "at_risk"
			default:
				s.AvailStatus = "healthy"
			}
			// Latency SLI from p95 (objective: p95 < 500ms).
			s.LatencyStatus = "healthy"
			if s.HasLatency {
				switch {
				case s.P95Ms >= 1000:
					s.LatencyStatus = "breached"
				case s.P95Ms >= 500:
					s.LatencyStatus = "at_risk"
				}
			}
			s.Status = worstStatus(s.AvailStatus, s.LatencyStatus)
			res = append(res, s)
		}
		writeJSON(w, res)
	})
}
