package query

import (
	"net/http"
	"strconv"
	"time"
)

func registerSynthetics(mux *http.ServeMux, r Reader) {
	// Monitor list with latest status + windowed uptime.
	mux.HandleFunc("GET /api/v1/synthetics", func(w http.ResponseWriter, req *http.Request) {
		from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), time.Hour)
		ms, err := r.ListMonitors(req.Context(), tenantOf(req), from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]map[string]any, 0, len(ms))
		for _, m := range ms {
			out = append(out, map[string]any{
				"monitor": m.Monitor, "url": m.URL, "up": m.Up, "status": m.Status,
				"latencyMs": m.LatencyMs, "uptime": m.Uptime, "avgLatencyMs": m.AvgLatencyMs,
				"checks": m.Checks, "lastErr": m.LastErr, "lastAt": m.LastAt.Format(time.RFC3339),
			})
		}
		writeJSON(w, out)
	})

	// Per-monitor uptime timeline (buckets) for the status bar.
	mux.HandleFunc("GET /api/v1/synthetics/{monitor}/timeline", func(w http.ResponseWriter, req *http.Request) {
		bucketSec, _ := strconv.Atoi(req.URL.Query().Get("bucketSec"))
		from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), time.Hour)
		ts, err := r.MonitorTimeline(req.Context(), tenantOf(req), req.PathValue("monitor"), from, to, bucketSec)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]map[string]any, 0, len(ts))
		for _, b := range ts {
			out = append(out, map[string]any{"time": b.Time.Format(time.RFC3339), "up": b.Up == 1, "latencyMs": b.LatencyMs})
		}
		writeJSON(w, out)
	})
}
