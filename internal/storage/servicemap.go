package storage

import (
	"context"
	"time"
)

type ServiceNode struct {
	Name         string
	RequestCount uint64
	ErrorCount   uint64
}

type ServiceEdge struct {
	From       string
	To         string
	CallCount  uint64
	ErrorCount uint64
	AvgMs      float64
}

type ServiceMap struct {
	Nodes []ServiceNode `json:"nodes"`
	Edges []ServiceEdge `json:"edges"`
}

func (s *Store) GetServiceMap(ctx context.Context, tenantID string, from, to time.Time) (ServiceMap, error) {
	var sm ServiceMap

	// Nodes: all services seen in the window, with SERVER request/error counts.
	const nodeQ = `
SELECT service_name,
       countIf(span_kind = 'SERVER') AS reqs,
       countIf(span_kind = 'SERVER' AND status_code = 'ERROR') AS errs
FROM apm.spans
WHERE tenant_id = ? AND start_time >= ? AND start_time <= ?
GROUP BY service_name
ORDER BY service_name`
	nrows, err := s.db.QueryContext(ctx, nodeQ, tenantID, from, to)
	if err != nil {
		return sm, err
	}
	defer nrows.Close()
	for nrows.Next() {
		var n ServiceNode
		if err := nrows.Scan(&n.Name, &n.RequestCount, &n.ErrorCount); err != nil {
			return sm, err
		}
		sm.Nodes = append(sm.Nodes, n)
	}
	if err := nrows.Err(); err != nil {
		return sm, err
	}

	// Edges: caller(parent span's service) -> callee(child SERVER span's service).
	// Both sides are time-windowed so the JOIN's right table (parent) is pruned to
	// the window instead of scanning the whole spans table (was OOM at 80M+ rows).
	// Parents start before their child, so widen the parent window by a margin.
	const edgeQ = `
SELECT parent.service_name AS from_service,
       child.service_name  AS to_service,
       count() AS calls,
       countIf(child.status_code = 'ERROR') AS errors,
       avg(child.duration_ns) / 1e6 AS avg_ms
FROM apm.spans AS child
INNER JOIN apm.spans AS parent
  ON child.tenant_id = parent.tenant_id
     AND child.trace_id = parent.trace_id
     AND child.parent_span_id = parent.span_id
WHERE child.tenant_id = ? AND child.span_kind = 'SERVER' AND child.parent_span_id != ''
  AND child.start_time >= ? AND child.start_time <= ?
  AND parent.tenant_id = ? AND parent.start_time >= ? AND parent.start_time <= ?
GROUP BY from_service, to_service
ORDER BY calls DESC`
	parentFrom := from.Add(-10 * time.Minute)
	erows, err := s.db.QueryContext(ctx, edgeQ, tenantID, from, to, tenantID, parentFrom, to)
	if err != nil {
		return sm, err
	}
	defer erows.Close()
	for erows.Next() {
		var e ServiceEdge
		if err := erows.Scan(&e.From, &e.To, &e.CallCount, &e.ErrorCount, &e.AvgMs); err != nil {
			return sm, err
		}
		sm.Edges = append(sm.Edges, e)
	}
	return sm, erows.Err()
}

type LiveTxn struct {
	TraceID     string
	Service     string
	Transaction string
	StatusCode  string
	StartTime   time.Time
	DurationMs  float64
	IsError     bool
}

func (s *Store) RecentRootTxns(ctx context.Context, tenantID string, since time.Time, limit int) ([]LiveTxn, error) {
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	const q = `
SELECT trace_id, service_name, http_route, span_name, status_code, start_time, duration_ns / 1e6 AS ms
FROM apm.spans
WHERE tenant_id = ? AND parent_span_id = '' AND start_time > ?
ORDER BY start_time ASC
LIMIT ?`
	rows, err := s.db.QueryContext(ctx, q, tenantID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LiveTxn
	for rows.Next() {
		var x LiveTxn
		var route, name string
		if err := rows.Scan(&x.TraceID, &x.Service, &route, &name, &x.StatusCode, &x.StartTime, &x.DurationMs); err != nil {
			return nil, err
		}
		x.Transaction = route
		if x.Transaction == "" {
			x.Transaction = name
		}
		x.IsError = x.StatusCode == "ERROR"
		out = append(out, x)
	}
	return out, rows.Err()
}

// BackfillTxns returns the most recent root transactions in a window (DESC so a
// LIMIT keeps the freshest, not the oldest). For seeding live widgets on load.
func (s *Store) BackfillTxns(ctx context.Context, tenantID string, since time.Time, limit int) ([]LiveTxn, error) {
	if limit <= 0 || limit > 8000 {
		limit = 3000
	}
	const q = `
SELECT trace_id, service_name, http_route, span_name, status_code, start_time, duration_ns / 1e6 AS ms
FROM apm.spans
WHERE tenant_id = ? AND parent_span_id = '' AND start_time > ?
ORDER BY start_time DESC
LIMIT ?`
	rows, err := s.db.QueryContext(ctx, q, tenantID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LiveTxn
	for rows.Next() {
		var x LiveTxn
		var route, name string
		if err := rows.Scan(&x.TraceID, &x.Service, &route, &name, &x.StatusCode, &x.StartTime, &x.DurationMs); err != nil {
			return nil, err
		}
		x.Transaction = route
		if x.Transaction == "" {
			x.Transaction = name
		}
		x.IsError = x.StatusCode == "ERROR"
		out = append(out, x)
	}
	return out, rows.Err()
}
