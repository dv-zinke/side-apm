package query

import (
	"net/http"
	"sort"
	"time"
)

type ServiceHealth struct {
	Service   string  `json:"service"`
	Status    string  `json:"status"` // healthy | degraded | down | idle
	ReqPerMin float64 `json:"reqPerMin"`
	ErrorRate float64 `json:"errorRate"`
	P95Ms     float64 `json:"p95Ms"`
	Anomalies int     `json:"anomalies"`
	Alerting  bool    `json:"alerting"`
}

type HealthSummary struct {
	Healthy       int `json:"healthy"`
	Degraded      int `json:"degraded"`
	Down          int `json:"down"`
	Idle          int `json:"idle"`
	ActiveAlerts  int `json:"activeAlerts"`
	Anomalies     int `json:"anomalies"`
	MonitorsUp    int `json:"monitorsUp"`
	MonitorsDown  int `json:"monitorsDown"`
	MonitorsTotal int `json:"monitorsTotal"`
}

func registerHealth(mux *http.ServeMux, r Reader) {
	// Single pane of glass: per-service health synthesized from RED + Apdex +
	// live anomalies + firing alerts, plus a fleet summary with synthetics.
	mux.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, req *http.Request) {
		ctx := req.Context()
		to := time.Now().UTC()
		from := to.Add(-30 * time.Minute)

		// firing alerts by service (latest event per rule that is still firing).
		alertingSvc := map[string]bool{}
		if alerts, err := r.ListAlerts(ctx, tenantOf(req), 200); err == nil {
			latest := map[string]string{} // ruleID -> latest state
			seen := map[string]bool{}
			for _, a := range alerts { // newest first
				if !seen[a.RuleID] {
					seen[a.RuleID] = true
					latest[a.RuleID] = a.State
					if a.State == "firing" {
						alertingSvc[a.Service] = true
					}
				}
			}
		}

		// All services' RED series in ONE query (was ListServices + N per-service
		// RED + N Apdex — a slow path self-tracing found). Anomaly detection runs
		// in-memory on the series; latency signal uses p95 (no Apdex fan-out).
		allRed, err := r.AllServicesRED(ctx, tenantOf(req), from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]ServiceHealth, 0, len(allRed))
		var sum HealthSummary
		for svc, red := range allRed {
			if len(red) == 0 {
				continue
			}
			h := ServiceHealth{Service: svc, Status: "idle", Alerting: alertingSvc[svc]}

			// A service that WAS reporting but whose latest bucket is stale has gone
			// silent (crashed / traffic cut) — surface it as down.
			if to.Sub(red[len(red)-1].Minute) > 3*time.Minute {
				h.Status = "down"
				sum.Down++
				out = append(out, h)
				continue
			}

			idx := len(red) - 1
			if len(red) >= 2 {
				idx = len(red) - 2 // most recent complete minute
			}
			p := red[idx]
			h.ReqPerMin = float64(p.RequestCount)
			if p.RequestCount > 0 {
				h.ErrorRate = 100 * float64(p.ErrorCount) / float64(p.RequestCount)
			}
			h.P95Ms = p.P95Ms

			var p95s, errs, thr []float64
			for _, x := range red {
				p95s = append(p95s, x.P95Ms)
				er := 0.0
				if x.RequestCount > 0 {
					er = 100 * float64(x.ErrorCount) / float64(x.RequestCount)
				}
				errs = append(errs, er)
				thr = append(thr, float64(x.RequestCount))
			}
			if _, ok := detect(svc, "p95_ms", p95s, 300, 0.5, false); ok {
				h.Anomalies++
			}
			if _, ok := detect(svc, "error_rate", errs, 1, 0.5, false); ok {
				h.Anomalies++
			}
			if _, ok := detect(svc, "throughput", thr, 5, 0.3, true); ok {
				h.Anomalies++
			}

			h.Status = classify(h)
			switch h.Status {
			case "healthy":
				sum.Healthy++
			case "degraded":
				sum.Degraded++
			case "down":
				sum.Down++
			default:
				sum.Idle++
			}
			sum.Anomalies += h.Anomalies
			out = append(out, h)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Service < out[j].Service })
		for _, a := range alertingSvc {
			if a {
				sum.ActiveAlerts++
			}
		}

		if monitors, err := r.ListMonitors(ctx, tenantOf(req), to.Add(-5*time.Minute), to); err == nil {
			for _, m := range monitors {
				sum.MonitorsTotal++
				if m.Up {
					sum.MonitorsUp++
				} else {
					sum.MonitorsDown++
				}
			}
		}

		writeJSON(w, map[string]any{"services": out, "summary": sum})
	})
}

func classify(h ServiceHealth) string {
	if h.ReqPerMin == 0 {
		return "idle"
	}
	if h.ErrorRate >= 25 {
		return "down"
	}
	if h.Alerting || h.Anomalies > 0 || h.ErrorRate >= 5 || h.P95Ms >= 600 {
		return "degraded"
	}
	return "healthy"
}
