package query

import (
	"net/http"
	"strconv"
	"time"
)

func registerProfiles(mux *http.ServeMux, r Reader) {
	// Recent profiles (metadata).
	mux.HandleFunc("GET /api/v1/profiles", func(w http.ResponseWriter, req *http.Request) {
		limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
		from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), 6*time.Hour)
		ms, err := r.ListProfiles(req.Context(), defaultTenant, from, to, limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]map[string]any, 0, len(ms))
		for _, m := range ms {
			out = append(out, map[string]any{
				"id": m.ID, "time": m.Time.Format(time.RFC3339), "target": m.Target,
				"type": m.Type, "unit": m.Unit, "samples": m.Samples,
			})
		}
		writeJSON(w, out)
	})

	// One profile's flame tree + top functions.
	mux.HandleFunc("GET /api/v1/profiles/{id}", func(w http.ResponseWriter, req *http.Request) {
		tree, top, unit, ptype, err := r.GetProfile(req.Context(), defaultTenant, req.PathValue("id"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if tree == "" {
			tree = "{}"
		}
		if top == "" {
			top = "[]"
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"unit":` + strconv.Quote(unit) + `,"type":` + strconv.Quote(ptype) +
			`,"tree":` + tree + `,"top":` + top + `}`))
	})
}
