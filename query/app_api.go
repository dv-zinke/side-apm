package query

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/heejune/apm/internal/storage"
)

func toAppGroups(rows []storage.AppGroup) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for _, g := range rows {
		out = append(out, map[string]any{"key": g.Key, "sub": g.Sub, "count": g.Count, "avgMs": g.AvgMs})
	}
	return out
}

func registerApp(mux *http.ServeMux, r Reader) {
	mux.HandleFunc("GET /api/v1/app/overview", func(w http.ResponseWriter, req *http.Request) {
		from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), time.Hour)
		o, err := r.AppOverview(req.Context(), defaultTenant, from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{
			"sessions": o.Sessions, "crashSessions": o.CrashSessions, "crashFreeRate": o.CrashFreeRate,
			"coldStartP75": o.ColdStartP75, "warmStartP75": o.WarmStartP75, "networkErrRate": o.NetworkErrRate,
		})
	})

	mux.HandleFunc("GET /api/v1/app/versions", func(w http.ResponseWriter, req *http.Request) {
		from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), time.Hour)
		vs, err := r.AppVersions(req.Context(), defaultTenant, from, to, 10)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]map[string]any, 0, len(vs))
		for _, v := range vs {
			out = append(out, map[string]any{"version": v.Version, "platform": v.Platform, "sessions": v.Sessions, "crashFreeRate": v.CrashFreeRate})
		}
		writeJSON(w, out)
	})

	group := func(fn func(context.Context, string, time.Time, time.Time, int) ([]storage.AppGroup, error)) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			from, to := resolveWindow(req.URL.Query().Get("from"), req.URL.Query().Get("to"), time.Hour)
			limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
			rows, err := fn(req.Context(), defaultTenant, from, to, limit)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			writeJSON(w, toAppGroups(rows))
		}
	}
	mux.HandleFunc("GET /api/v1/app/screens", group(r.TopScreens))
	mux.HandleFunc("GET /api/v1/app/crashes", group(r.TopCrashes))
	mux.HandleFunc("GET /api/v1/app/network", group(r.TopAppNetwork))
}
