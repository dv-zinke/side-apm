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
	Apdex           float64 `json:"apdex"`
	HasApdex        bool    `json:"hasApdex"`
	AvailStatus     string  `json:"availStatus"`   // availability SLI
	LatencyStatus   string  `json:"latencyStatus"` // latency SLI (Apdex)
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

		services, err := r.ListServices(ctx, defaultTenant)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]SLOStatus, 0)
		for _, svc := range services {
			red, err := r.GetServiceRED(ctx, defaultTenant, svc, from, to)
			if err != nil || len(red) == 0 {
				continue
			}
			var totalReq, totalErr uint64
			for _, p := range red {
				totalReq += p.RequestCount
				totalErr += p.ErrorCount
			}
			if totalReq == 0 {
				continue
			}
			success := 100 * float64(totalReq-totalErr) / float64(totalReq)
			budget := 100 - target // allowed error %
			errPct := 100 * float64(totalErr) / float64(totalReq)
			consumed := 0.0
			if budget > 0 {
				consumed = 100 * errPct / budget
			}
			s := SLOStatus{
				Service: svc, WindowHours: windowHours, TotalReq: totalReq, TotalErr: totalErr,
				SuccessRate: success, Target: target, BudgetConsumed: consumed, BudgetRemaining: 100 - consumed,
			}
			if s.BudgetRemaining < 0 {
				s.BudgetRemaining = 0
			}
			if score, _, ok, err := r.ServiceApdex(ctx, defaultTenant, svc, 500, from, to); err == nil && ok {
				s.Apdex, s.HasApdex = score, true
			}
			// Availability SLI (error budget) …
			switch {
			case success < target:
				s.AvailStatus = "breached"
			case consumed >= 50:
				s.AvailStatus = "at_risk"
			default:
				s.AvailStatus = "healthy"
			}
			// … and latency SLI (Apdex ≥ 0.9 target) so a latency-degraded service
			// doesn't read as fully healthy here while the health view flags it.
			s.LatencyStatus = "healthy"
			if s.HasApdex {
				switch {
				case s.Apdex < 0.8:
					s.LatencyStatus = "breached"
				case s.Apdex < 0.9:
					s.LatencyStatus = "at_risk"
				}
			}
			s.Status = worstStatus(s.AvailStatus, s.LatencyStatus)
			out = append(out, s)
		}
		writeJSON(w, out)
	})
}
