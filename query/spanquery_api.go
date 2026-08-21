package query

import (
	"net/http"
	"strconv"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type SpanQueryRowDTO struct {
	TraceID    string  `json:"traceId"`
	SpanID     string  `json:"spanId"`
	Service    string  `json:"service"`
	Name       string  `json:"name"`
	Status     string  `json:"status"`
	DurationMs float64 `json:"durationMs"`
	StartTime  string  `json:"startTime"`
	HTTPStatus uint16  `json:"httpStatus"`
	HTTPRoute  string  `json:"httpRoute"`
}

type FacetRowDTO struct {
	Key    string    `json:"key"`
	Values []float64 `json:"values"`
}

type SpanQueryDTO struct {
	Kind      string           `json:"kind"` // spans | facets
	Spans     []SpanQueryRowDTO `json:"spans,omitempty"`
	Fields    []string         `json:"fields,omitempty"`
	AggLabels []string         `json:"aggLabels,omitempty"`
	Rows      []FacetRowDTO    `json:"rows,omitempty"`
}

func registerSpanQuery(mux *http.ServeMux, r Reader) {
	// Ad-hoc span search — a safe restricted query language over apm.spans.
	// A plain filter returns spans; a `| stats … by …` pipe returns facets.
	// A bad query returns 400 with a human message so the UI can show it inline.
	mux.HandleFunc("GET /api/v1/spans/query", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		from, to := resolveWindow(q.Get("from"), q.Get("to"), time.Hour)
		limit, _ := strconv.Atoi(q.Get("limit"))
		res, err := r.RunSpanQuery(req.Context(), tenantOf(req), q.Get("q"), from, to, limit)
		if err != nil {
			if storage.IsQueryError(err) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := SpanQueryDTO{Kind: res.Kind}
		if res.Kind == "facets" {
			out.Fields = res.Facet.Fields
			out.AggLabels = res.Facet.AggLabels
			out.Rows = make([]FacetRowDTO, 0, len(res.Facet.Rows))
			for _, fr := range res.Facet.Rows {
				out.Rows = append(out.Rows, FacetRowDTO{Key: fr.Key, Values: fr.Values})
			}
		} else {
			out.Spans = make([]SpanQueryRowDTO, 0, len(res.Spans))
			for _, s := range res.Spans {
				out.Spans = append(out.Spans, SpanQueryRowDTO{
					TraceID: s.TraceID, SpanID: s.SpanID, Service: s.Service, Name: s.Name, Status: s.Status,
					DurationMs: float64(s.DurationNs) / 1e6, StartTime: s.StartTime.Format(time.RFC3339Nano),
					HTTPStatus: s.HTTPStatus, HTTPRoute: s.HTTPRoute,
				})
			}
		}
		writeJSON(w, out)
	})
}
