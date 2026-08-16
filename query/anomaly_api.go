package query

import (
	"math"
	"net/http"
	"strconv"
	"time"
)

type Anomaly struct {
	Service   string  `json:"service"`
	Metric    string  `json:"metric"`
	Current   float64 `json:"current"`
	Baseline  float64 `json:"baseline"`
	Stddev    float64 `json:"stddev"`
	Z         float64 `json:"z"`
	Direction string  `json:"direction"` // up | down
	Severity  string  `json:"severity"`  // warning | critical
}

func meanStddev(xs []float64) (float64, float64) {
	if len(xs) == 0 {
		return 0, 0
	}
	var sum float64
	for _, x := range xs {
		sum += x
	}
	m := sum / float64(len(xs))
	var v float64
	for _, x := range xs {
		v += (x - m) * (x - m)
	}
	return m, math.Sqrt(v / float64(len(xs)))
}

// detect flags an anomaly only when BOTH gates trip: statistical (≥3σ vs the
// service's own baseline) AND practical (≥minRel relative change above a floor).
// The dual gate stops a rock-steady metric from alerting on trivial noise, and
// the incomplete current-minute bucket is dropped so partial data doesn't read
// as a throughput dip.
func detect(service, metric string, series []float64, minCurrent, minRel float64, wantDrop bool) (Anomaly, bool) {
	if len(series) > 0 {
		series = series[:len(series)-1] // drop incomplete current minute
	}
	const recentN = 3
	n := len(series)
	if n < recentN+8 {
		return Anomaly{}, false
	}
	recent, _ := meanStddev(series[n-recentN:])
	base, sd := meanStddev(series[:n-recentN])
	if base < 1e-9 || sd < 1e-9 {
		return Anomaly{}, false
	}
	z := (recent - base) / sd
	rel := (recent - base) / base
	dir := "up"
	if wantDrop {
		if z > -3 || rel > -minRel || base < minCurrent {
			return Anomaly{}, false
		}
		dir = "down"
	} else {
		if z < 3 || rel < minRel || recent < minCurrent {
			return Anomaly{}, false
		}
	}
	sev := "warning"
	if math.Abs(z) >= 5 && math.Abs(rel) >= 1 {
		sev = "critical"
	}
	return Anomaly{Service: service, Metric: metric, Current: recent, Baseline: base, Stddev: sd, Z: z, Direction: dir, Severity: sev}, true
}

func registerAnomalies(mux *http.ServeMux, r Reader) {
	// Auto-baseline anomaly scan across services — no manual thresholds. Compares
	// each service's recent p95 / error-rate / throughput against its own trend.
	mux.HandleFunc("GET /api/v1/anomalies", func(w http.ResponseWriter, req *http.Request) {
		windowMin, _ := strconv.Atoi(req.URL.Query().Get("windowMin"))
		if windowMin <= 0 {
			windowMin = 60
		}
		to := time.Now().UTC()
		from := to.Add(-time.Duration(windowMin) * time.Minute)
		services, err := r.ListServices(req.Context(), defaultTenant)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]Anomaly, 0)
		for _, svc := range services {
			red, err := r.GetServiceRED(req.Context(), defaultTenant, svc, from, to)
			// detect() drops the incomplete current bucket then needs recentN+8=11,
			// so it needs 12 raw buckets — align the guard to avoid silent skips.
			if err != nil || len(red) < 12 {
				continue
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
			if a, ok := detect(svc, "p95_ms", p95, 300, 0.5, false); ok {
				out = append(out, a)
			}
			if a, ok := detect(svc, "error_rate", errRate, 1, 0.5, false); ok {
				out = append(out, a)
			}
			if a, ok := detect(svc, "throughput", thr, 5, 0.3, true); ok {
				out = append(out, a)
			}
		}
		writeJSON(w, out)
	})
}
