package query

import (
	"net/http"
	"time"
)

type ContainerDTO struct {
	Container string  `json:"container"`
	Image     string  `json:"image"`
	Status    string  `json:"status"`
	CPUPct    float64 `json:"cpuPct"`
	MemBytes  uint64  `json:"memBytes"`
	MemLimit  uint64  `json:"memLimit"`
	MemPct    float64 `json:"memPct"`
	NetRx     uint64  `json:"netRx"`
	NetTx     uint64  `json:"netTx"`
	Time      string  `json:"time"`
}

func registerInfra(mux *http.ServeMux, r Reader) {
	// Host-level metrics snapshot (CPU/mem/load + container counts).
	mux.HandleFunc("GET /api/v1/infra/host", func(w http.ResponseWriter, req *http.Request) {
		h, ok, err := r.LatestHost(req.Context(), defaultTenant)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if !ok {
			writeJSON(w, map[string]any{"hasData": false})
			return
		}
		writeJSON(w, map[string]any{
			"hasData": true, "cpuPct": h.CPUPct, "memUsed": h.MemUsed, "memTotal": h.MemTotal, "memPct": h.MemPct,
			"ncpu": h.NCPU, "load1": h.Load1, "containersRunning": h.ContainersRunning, "containersTotal": h.ContainersTotal,
			"time": h.Time.Format(time.RFC3339),
		})
	})

	mux.HandleFunc("GET /api/v1/infra/containers", func(w http.ResponseWriter, req *http.Request) {
		from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), 5*time.Minute)
		cs, err := r.ListContainers(req.Context(), defaultTenant, from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]ContainerDTO, 0, len(cs))
		for _, c := range cs {
			out = append(out, ContainerDTO{
				Container: c.Container, Image: c.Image, Status: c.Status, CPUPct: c.CPUPct,
				MemBytes: c.MemBytes, MemLimit: c.MemLimit, MemPct: c.MemPct, NetRx: c.NetRx, NetTx: c.NetTx,
				Time: c.Time.Format(time.RFC3339),
			})
		}
		writeJSON(w, out)
	})

	mux.HandleFunc("GET /api/v1/infra/containers/{name}/series", func(w http.ResponseWriter, req *http.Request) {
		metric := req.URL.Query().Get("metric")
		if metric == "" {
			metric = "cpu_pct"
		}
		switch metric {
		case "cpu_pct", "mem_pct", "mem_bytes", "net_rx", "net_tx":
		default:
			http.Error(w, "metric must be cpu_pct|mem_pct|mem_bytes|net_rx|net_tx", http.StatusBadRequest)
			return
		}
		from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), time.Hour)
		pts, err := r.ContainerSeries(req.Context(), defaultTenant, req.PathValue("name"), metric, from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]MetricPointDTO, 0, len(pts))
		for _, p := range pts {
			out = append(out, MetricPointDTO{Time: p.Time.Format(time.RFC3339), Value: p.Value})
		}
		writeJSON(w, out)
	})
}
