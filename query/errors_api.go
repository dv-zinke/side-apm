package query

import (
	"net/http"
	"strconv"
	"time"
)

type ErrorGroupDTO struct {
	Fingerprint string `json:"fingerprint"`
	Service     string `json:"service"`
	Operation   string `json:"operation"`
	ErrorType   string `json:"errorType"`
	Message     string `json:"message"`
	Count       uint64 `json:"count"`
	FirstSeen   string `json:"firstSeen"`
	LastSeen    string `json:"lastSeen"`
	Status      uint16 `json:"status"`
	SampleTrace string `json:"sampleTrace"`
}

type ErrorSampleDTO struct {
	TraceID string `json:"traceId"`
	Time    string `json:"time"`
	Message string `json:"message"`
	Status  uint16 `json:"status"`
}

type ErrorTrendDTO struct {
	Minute string `json:"minute"`
	Count  uint64 `json:"count"`
}

type ErrorDetailDTO struct {
	Total   uint64           `json:"total"`
	Trend   []ErrorTrendDTO  `json:"trend"`
	Samples []ErrorSampleDTO `json:"samples"`
}

func registerErrors(mux *http.ServeMux, r Reader) {
	// Error Tracking inbox: individual error spans grouped into issues by
	// (service, operation, errorType). Built entirely from apm.spans — no new
	// ingest path. Honors the shared time window.
	mux.HandleFunc("GET /api/v1/errors", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		from, to := resolveWindow(q.Get("from"), q.Get("to"), time.Hour)
		limit, _ := strconv.Atoi(q.Get("limit"))
		if limit <= 0 || limit > 200 {
			limit = 100
		}
		groups, err := r.ErrorGroups(req.Context(), tenantOf(req), from, to, limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]ErrorGroupDTO, 0, len(groups))
		for _, g := range groups {
			out = append(out, ErrorGroupDTO{
				Fingerprint: g.Fingerprint, Service: g.Service, Operation: g.Operation, ErrorType: g.ErrorType,
				Message: g.Message, Count: g.Count, Status: g.Status, SampleTrace: g.SampleTrace,
				FirstSeen: g.FirstSeen.Format(time.RFC3339), LastSeen: g.LastSeen.Format(time.RFC3339),
			})
		}
		writeJSON(w, out)
	})

	// One issue's occurrence trend + recent sample traces. The group is
	// identified by its (service, operation, errorType) tuple.
	mux.HandleFunc("GET /api/v1/errors/detail", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		from, to := resolveWindow(q.Get("from"), q.Get("to"), time.Hour)
		step, _ := strconv.Atoi(q.Get("step"))
		d, err := r.ErrorGroupDetail(req.Context(), tenantOf(req), q.Get("service"), q.Get("op"), q.Get("etype"), from, to, step)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := ErrorDetailDTO{Total: d.Total}
		for _, p := range d.Trend {
			out.Trend = append(out.Trend, ErrorTrendDTO{Minute: p.Minute.Format(time.RFC3339), Count: p.Count})
		}
		for _, s := range d.Samples {
			out.Samples = append(out.Samples, ErrorSampleDTO{TraceID: s.TraceID, Time: s.Time.Format(time.RFC3339), Message: s.Message, Status: s.Status})
		}
		writeJSON(w, out)
	})
}
