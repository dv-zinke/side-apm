package query

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"github.com/heejune/apm/internal/storage"
)

type dashboardDTO struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Spec  json.RawMessage `json:"spec"`
}

func registerDashboards(mux *http.ServeMux, r Reader) {
	mux.HandleFunc("GET /api/v1/dashboards", func(w http.ResponseWriter, req *http.Request) {
		ds, err := r.ListDashboards(req.Context(), defaultTenant)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]dashboardDTO, 0, len(ds))
		for _, d := range ds {
			spec := json.RawMessage(d.Spec)
			if len(spec) == 0 {
				spec = json.RawMessage("{}")
			}
			out = append(out, dashboardDTO{ID: d.ID, Name: d.Name, Spec: spec})
		}
		writeJSON(w, out)
	})

	mux.HandleFunc("POST /api/v1/dashboards", func(w http.ResponseWriter, req *http.Request) {
		var dto dashboardDTO
		if err := json.NewDecoder(req.Body).Decode(&dto); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if dto.Name == "" {
			http.Error(w, "name required", http.StatusBadRequest)
			return
		}
		if dto.ID == "" {
			b := make([]byte, 8)
			_, _ = rand.Read(b)
			dto.ID = hex.EncodeToString(b)
		}
		spec := string(dto.Spec)
		if spec == "" {
			spec = "{}"
		}
		if err := r.UpsertDashboard(req.Context(), defaultTenant, storage.Dashboard{ID: dto.ID, Name: dto.Name, Spec: spec}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, dto)
	})

	mux.HandleFunc("DELETE /api/v1/dashboards/{id}", func(w http.ResponseWriter, req *http.Request) {
		if err := r.DeleteDashboard(req.Context(), defaultTenant, req.PathValue("id")); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}
