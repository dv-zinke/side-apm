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
		o, err := r.RumOverview(req.Context(), tenantOf(req), from, to)
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
			rows, err := fn(req.Context(), tenantOf(req), from, to, limit)
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

	// Session replays — list metadata, then fetch one replay's rrweb events.
	mux.HandleFunc("GET /api/v1/rum/replays", func(w http.ResponseWriter, req *http.Request) {
		from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), 7*24*time.Hour)
		limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
		rows, err := r.ListReplays(req.Context(), tenantOf(req), from, to, limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]map[string]any, 0, len(rows))
		for _, m := range rows {
			out = append(out, map[string]any{
				"id": m.ID, "time": m.Time.Format(time.RFC3339), "sessionId": m.SessionID,
				"page": m.Page, "message": m.Message,
			})
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("GET /api/v1/rum/replays/{id}", func(w http.ResponseWriter, req *http.Request) {
		events, err := r.GetReplay(req.Context(), tenantOf(req), req.PathValue("id"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if events == "" {
			events = "[]"
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(events))
	})
}
