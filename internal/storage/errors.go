package storage

import (
	"context"
	"fmt"
	"hash/fnv"
	"time"
)

// Error tracking — group individual error spans into issues (like Datadog Error
// Tracking / New Relic Errors Inbox). No new schema: aggregate over apm.spans.
//
// Fingerprint degrades gracefully so it works whether or not the app reports
// rich error attributes:
//   error type = span_attrs['http.error_name']  (e.g. "ECONNRESET")
//             else "HTTP <status>"              (e.g. "HTTP 500")
//   operation  = span_name  else http_route
// Two spans with the same (service, operation, errorType) are the same issue.

type ErrorGroup struct {
	Fingerprint string
	Service     string
	Operation   string
	ErrorType   string
	Message     string
	Count       uint64
	FirstSeen   time.Time
	LastSeen    time.Time
	Status      uint16 // representative HTTP status
	SampleTrace string
	State       string // triage: active | resolved | ignored | regressed
}

type ErrorSample struct {
	TraceID string
	Time    time.Time
	Message string
	Status  uint16
}

type ErrorTrendPoint struct {
	Minute time.Time
	Count  uint64
}

type ErrorGroupDetail struct {
	Trend   []ErrorTrendPoint
	Samples []ErrorSample
	Total   uint64
}

// fingerprint is a stable id for (service, operation, errorType) — used as the
// React key and to re-select the group on drill-down.
func fingerprint(service, op, etype string) string {
	h := fnv.New64a()
	h.Write([]byte(service + "\x00" + op + "\x00" + etype))
	return fmt.Sprintf("%016x", h.Sum64())
}

// The SQL fragments that derive operation + errorType, shared by list & detail so
// the grouping stays identical on both sides.
//
// errType degrades: normalized error message (digits/uuids masked so
// "timeout 500ms" and "timeout 1200ms" fold together, while "socket hang up" and
// "ECONNRESET" stay distinct) → error_name → "HTTP <status>". Message-first so a
// generic exception name ("Error") doesn't collapse different root causes.
const errOp = "if(span_name != '', span_name, http_route)"
const errType = `multiIf(
  span_attrs['http.error_message'] != '', replaceRegexpAll(replaceRegexpAll(span_attrs['http.error_message'], '[0-9a-f]{8}-[0-9a-f-]{20,}', 'ID'), '[0-9]+', 'N'),
  span_attrs['http.error_name'] != '', span_attrs['http.error_name'],
  concat('HTTP ', toString(http_status_code)))`

// errStatus holds a triage state + when it was set (for regression detection).
type errStatus struct {
	state string
	ts    time.Time
}

// SetErrorStatus records a triage decision for one issue (upsert by fingerprint).
func (s *Store) SetErrorStatus(ctx context.Context, tenantID, fingerprint, state string) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.error_status (tenant_id, fingerprint, status, updated_at) VALUES (?,?,?,?)",
		tenantID, fingerprint, state, time.Now().UTC())
	return err
}

func (s *Store) errorStatuses(ctx context.Context, tenantID string) (map[string]errStatus, error) {
	rows, err := s.db.QueryContext(ctx,
		"SELECT fingerprint, status, updated_at FROM apm.error_status FINAL WHERE tenant_id = ?", tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := map[string]errStatus{}
	for rows.Next() {
		var fp string
		var st errStatus
		if err := rows.Scan(&fp, &st.state, &st.ts); err != nil {
			return nil, err
		}
		m[fp] = st
	}
	return m, rows.Err()
}

// ErrorGroups lists issue groups over the window, annotated with triage state.
// stateFilter: "active" (active + regressed), "resolved", "ignored", or "all".
func (s *Store) ErrorGroups(ctx context.Context, tenantID, stateFilter string, from, to time.Time, limit int) ([]ErrorGroup, error) {
	statuses, err := s.errorStatuses(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	q := fmt.Sprintf(`
SELECT
    service_name AS svc,
    %s AS op,
    %s AS etype,
    anyLast(span_attrs['http.error_message']) AS emsg,
    count() AS cnt,
    min(start_time) AS first_seen,
    max(start_time) AS last_seen,
    argMax(http_status_code, start_time) AS status,
    argMax(trace_id, start_time) AS sample
FROM apm.spans
WHERE tenant_id = ? AND status_code = 'ERROR' AND start_time >= ? AND start_time <= ?
GROUP BY svc, op, etype
ORDER BY cnt DESC
LIMIT ?`, errOp, errType)
	// Fetch a wider slice than requested so the post-annotation state filter can
	// still return up to `limit` matching groups.
	fetch := limit
	if stateFilter != "" && stateFilter != "all" {
		fetch = limit * 5
		if fetch > 1000 {
			fetch = 1000
		}
	}
	rows, err := s.db.QueryContext(ctx, q, tenantID, from, to, fetch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ErrorGroup, 0, limit)
	for rows.Next() {
		var g ErrorGroup
		if err := rows.Scan(&g.Service, &g.Operation, &g.ErrorType, &g.Message, &g.Count, &g.FirstSeen, &g.LastSeen, &g.Status, &g.SampleTrace); err != nil {
			return nil, err
		}
		g.Fingerprint = fingerprint(g.Service, g.Operation, g.ErrorType)
		// Effective triage state: default active; a resolved issue that keeps
		// occurring after it was resolved is "regressed".
		g.State = "active"
		if st, ok := statuses[g.Fingerprint]; ok {
			g.State = st.state
			if st.state == "resolved" && g.LastSeen.After(st.ts) {
				g.State = "regressed"
			}
		}
		if !matchesStateFilter(g.State, stateFilter) {
			continue
		}
		out = append(out, g)
		if len(out) >= limit {
			break
		}
	}
	return out, rows.Err()
}

func matchesStateFilter(state, filter string) bool {
	switch filter {
	case "", "active":
		return state == "active" || state == "regressed"
	case "all":
		return true
	default:
		return state == filter
	}
}

// ErrorGroupDetail returns the occurrence trend + recent sample traces for one
// group, identified by its (service, operation, errorType) tuple.
func (s *Store) ErrorGroupDetail(ctx context.Context, tenantID, service, op, etype string, from, to time.Time, stepMin int) (ErrorGroupDetail, error) {
	if stepMin < 1 {
		stepMin = 1
	}
	where := fmt.Sprintf("tenant_id = ? AND status_code = 'ERROR' AND service_name = ? AND %s = ? AND %s = ? AND start_time >= ? AND start_time <= ?", errOp, errType)
	var d ErrorGroupDetail

	trendQ := fmt.Sprintf(`SELECT toStartOfInterval(start_time, INTERVAL %d MINUTE) AS b, count() FROM apm.spans WHERE %s GROUP BY b ORDER BY b`, stepMin, where)
	rows, err := s.db.QueryContext(ctx, trendQ, tenantID, service, op, etype, from, to)
	if err != nil {
		return d, err
	}
	for rows.Next() {
		var p ErrorTrendPoint
		if err := rows.Scan(&p.Minute, &p.Count); err != nil {
			rows.Close()
			return d, err
		}
		d.Trend = append(d.Trend, p)
		d.Total += p.Count
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return d, err
	}

	sampleQ := fmt.Sprintf(`SELECT trace_id, start_time, span_attrs['http.error_message'], http_status_code FROM apm.spans WHERE %s ORDER BY start_time DESC LIMIT 20`, where)
	srows, err := s.db.QueryContext(ctx, sampleQ, tenantID, service, op, etype, from, to)
	if err != nil {
		return d, err
	}
	defer srows.Close()
	for srows.Next() {
		var e ErrorSample
		if err := srows.Scan(&e.TraceID, &e.Time, &e.Message, &e.Status); err != nil {
			return d, err
		}
		d.Samples = append(d.Samples, e)
	}
	return d, srows.Err()
}
