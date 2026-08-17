package query

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type deployIn struct {
	Service     string `json:"service"`
	Version     string `json:"version"`
	Description string `json:"description"`
	TS          int64  `json:"ts"` // epoch ms, optional (defaults to now)
}

func registerDeploys(mux *http.ServeMux, r Reader) {
	// Record a deploy/release marker (from CI or manually).
	mux.HandleFunc("POST /api/v1/deploys", func(w http.ResponseWriter, req *http.Request) {
		var in deployIn
		if err := json.NewDecoder(req.Body).Decode(&in); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if in.Service == "" || in.Version == "" {
			http.Error(w, "service, version required", http.StatusBadRequest)
			return
		}
		ts := time.Now().UTC()
		if in.TS > 0 {
			ts = time.UnixMilli(in.TS).UTC()
		}
		if err := r.InsertDeploy(req.Context(), tenantOf(req), storage.Deploy{
			Time: ts, Service: in.Service, Version: in.Version, Description: in.Description,
		}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	// List deploy markers (optionally per service) for chart overlays + history.
	mux.HandleFunc("GET /api/v1/deploys", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		from, to := resolveWindow(q.Get("from"), q.Get("to"), 24*time.Hour)
		ds, err := r.ListDeploys(req.Context(), tenantOf(req), q.Get("service"), from, to, limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]map[string]any, 0, len(ds))
		for _, d := range ds {
			out = append(out, map[string]any{
				"time": d.Time.Format(time.RFC3339), "service": d.Service,
				"version": d.Version, "description": d.Description,
			})
		}
		writeJSON(w, out)
	})
}
