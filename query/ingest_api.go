package query

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type SamplingRuleDTO struct {
	ID       string  `json:"id"`
	Service  string  `json:"service"` // "*" = tenant default
	KeepRate float64 `json:"keepRate"`
	Enabled  bool    `json:"enabled"`
}

type IngestStatDTO struct {
	Minute   string `json:"minute"`
	Received uint64 `json:"received"`
	Kept     uint64 `json:"kept"`
	Dropped  uint64 `json:"dropped"`
}

func registerIngest(mux *http.ServeMux, r Reader) {
	mux.HandleFunc("GET /api/v1/ingest/sampling", func(w http.ResponseWriter, req *http.Request) {
		rules, err := r.ListSamplingRules(req.Context(), tenantOf(req))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]SamplingRuleDTO, 0, len(rules))
		for _, x := range rules {
			out = append(out, SamplingRuleDTO{x.ID, x.Service, x.KeepRate, x.Enabled})
		}
		writeJSON(w, out)
	})

	mux.HandleFunc("POST /api/v1/ingest/sampling", func(w http.ResponseWriter, req *http.Request) {
		var dto SamplingRuleDTO
		if err := json.NewDecoder(req.Body).Decode(&dto); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if dto.Service == "" || dto.KeepRate < 0 || dto.KeepRate > 1 {
			http.Error(w, "service and keepRate(0.0–1.0) required", http.StatusBadRequest)
			return
		}
		if dto.ID == "" {
			dto.ID = newID()
		}
		if err := r.UpsertSamplingRule(req.Context(), tenantOf(req), storage.SamplingRule{
			ID: dto.ID, Service: dto.Service, KeepRate: dto.KeepRate, Enabled: dto.Enabled,
		}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, dto)
	})

	mux.HandleFunc("DELETE /api/v1/ingest/sampling/{id}", func(w http.ResponseWriter, req *http.Request) {
		if err := r.DeleteSamplingRule(req.Context(), tenantOf(req), req.PathValue("id")); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	// Ingest volume over the window — received/kept/dropped per minute.
	mux.HandleFunc("GET /api/v1/ingest/stats", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		from, to := resolveWindow(q.Get("from"), q.Get("to"), time.Hour)
		stats, err := r.IngestStats(req.Context(), tenantOf(req), from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]IngestStatDTO, 0, len(stats))
		for _, s := range stats {
			out = append(out, IngestStatDTO{
				Minute: s.Ts.Format(time.RFC3339), Received: s.Received, Kept: s.Kept, Dropped: s.Dropped,
			})
		}
		writeJSON(w, out)
	})
}
