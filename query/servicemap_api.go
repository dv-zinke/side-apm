package query

import (
	"encoding/json"
	"io"
	"net/http"
	"time"
)

type ServiceNodeDTO struct {
	Name         string `json:"name"`
	RequestCount uint64 `json:"requestCount"`
	ErrorCount   uint64 `json:"errorCount"`
}
type ServiceEdgeDTO struct {
	From       string  `json:"from"`
	To         string  `json:"to"`
	CallCount  uint64  `json:"callCount"`
	ErrorCount uint64  `json:"errorCount"`
	AvgMs      float64 `json:"avgMs"`
}
type ServiceMapDTO struct {
	Nodes []ServiceNodeDTO `json:"nodes"`
	Edges []ServiceEdgeDTO `json:"edges"`
}
type LiveTxnDTO struct {
	TraceID     string  `json:"traceId"`
	Service     string  `json:"service"`
	Transaction string  `json:"transaction"`
	StatusCode  string  `json:"statusCode"`
	StartTime   string  `json:"startTime"`
	DurationMs  float64 `json:"durationMs"`
	IsError     bool    `json:"isError"`
}

func registerServiceMap(mux *http.ServeMux, r Reader) {
	mux.HandleFunc("GET /api/v1/servicemap", func(w http.ResponseWriter, req *http.Request) {
		from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), 15*time.Minute)
		sm, err := r.GetServiceMap(req.Context(), defaultTenant, from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := ServiceMapDTO{Nodes: []ServiceNodeDTO{}, Edges: []ServiceEdgeDTO{}}
		for _, n := range sm.Nodes {
			out.Nodes = append(out.Nodes, ServiceNodeDTO{n.Name, n.RequestCount, n.ErrorCount})
		}
		for _, e := range sm.Edges {
			out.Edges = append(out.Edges, ServiceEdgeDTO{e.From, e.To, e.CallCount, e.ErrorCount, e.AvgMs})
		}
		writeJSON(w, out)
	})

	// SSE live X-View stream: push new root transactions as they appear.
	mux.HandleFunc("GET /api/v1/live/transactions", func(w http.ResponseWriter, req *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "stream unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("Access-Control-Allow-Origin", "*")

		ctx := req.Context()
		since := time.Now().UTC().Add(-5 * time.Second)
		seen := make(map[string]struct{})
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		writeStr := func(s string) bool {
			if _, err := io.WriteString(w, s); err != nil {
				return false
			}
			return true
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				txns, err := r.RecentRootTxns(ctx, defaultTenant, since, 500)
				if err == nil {
					for _, x := range txns {
						if _, dup := seen[x.TraceID]; dup {
							continue
						}
						seen[x.TraceID] = struct{}{}
						if x.StartTime.After(since) {
							since = x.StartTime
						}
						b, _ := json.Marshal(LiveTxnDTO{
							TraceID: x.TraceID, Service: x.Service, Transaction: x.Transaction,
							StatusCode: x.StatusCode, StartTime: x.StartTime.Format(time.RFC3339Nano),
							DurationMs: x.DurationMs, IsError: x.IsError,
						})
						if !writeStr("data: " + string(b) + "\n\n") {
							return
						}
					}
					if len(seen) > 5000 {
						seen = make(map[string]struct{})
					}
				}
				// heartbeat: detect dead connections even when idle
				if !writeStr(": ping\n\n") {
					return
				}
				flusher.Flush()
			}
		}
	})
}
