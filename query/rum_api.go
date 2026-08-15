package query

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type RumCountDTO struct {
	Key   string  `json:"key"`
	Sub   string  `json:"sub"`
	Count uint64  `json:"count"`
	AvgMs float64 `json:"avgMs"`
}

func toRumCounts(rows []storage.RumCount) []RumCountDTO {
	out := make([]RumCountDTO, 0, len(rows))
	for _, c := range rows {
		out = append(out, RumCountDTO{Key: c.Key, Sub: c.Sub, Count: c.Count, AvgMs: c.AvgMs})
	}
	return out
}

func registerRum(mux *http.ServeMux, r Reader) {
	mux.HandleFunc("GET /api/v1/rum/overview", func(w http.ResponseWriter, req *http.Request) {
		from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), time.Hour)
		o, err := r.RumOverview(req.Context(), defaultTenant, from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{
			"sessions": o.Sessions, "pageviews": o.Pageviews, "errors": o.Errors,
			"lcpP75": o.LCPp75, "inpP75": o.INPp75, "clsP75": o.CLSp75,
		})
	})

	group := func(fn func(context.Context, string, time.Time, time.Time, int) ([]storage.RumCount, error)) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), time.Hour)
			limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
			rows, err := fn(req.Context(), defaultTenant, from, to, limit)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, toRumCounts(rows))
		}
	}
	mux.HandleFunc("GET /api/v1/rum/clicks", group(r.TopClicks))
	mux.HandleFunc("GET /api/v1/rum/errors", group(r.TopErrors))
	mux.HandleFunc("GET /api/v1/rum/resources", group(r.TopResources))
}
