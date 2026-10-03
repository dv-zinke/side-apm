package storage

import (
	"context"
	"time"
)

type QueryStat struct {
	Service   string
	Statement string
	DBSystem  string
	Calls     uint64
	AvgMs     float64
	P95Ms     float64
	MaxMs     float64
	TotalMs   float64
}

// TopQueries aggregates DB spans by (service, normalized statement) — the core
// of database monitoring: which queries cost the most and which run slowest.
// orderBy: "total" (impact) | "max" (slowest) | "calls".
func (s *Store) TopQueries(ctx context.Context, tenantID, service, orderBy string, from, to time.Time, limit int) ([]QueryStat, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	order := "total_ms"
	switch orderBy {
	case "max":
		order = "max_ms"
	case "calls":
		order = "calls"
	}
	q := `
SELECT service_name, db_statement, any(db_system) AS db_sys,
       count() AS calls,
       avg(duration_ns) / 1e6 AS avg_ms,
       quantile(0.95)(duration_ns) / 1e6 AS p95_ms,
       max(duration_ns) / 1e6 AS max_ms,
       sum(duration_ns) / 1e6 AS total_ms
FROM apm.spans
WHERE tenant_id = ? AND db_statement != '' AND start_time >= ? AND start_time <= ?
  AND (? = '' OR service_name = ?)
GROUP BY service_name, db_statement
ORDER BY ` + order + ` DESC
LIMIT ?`
	rows, err := s.db.QueryContext(ctx, q, tenantID, from, to, service, service, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []QueryStat
	for rows.Next() {
		var x QueryStat
		if err := rows.Scan(&x.Service, &x.Statement, &x.DBSystem, &x.Calls, &x.AvgMs, &x.P95Ms, &x.MaxMs, &x.TotalMs); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

type NPlusOneStat struct {
	Service    string
	Statement  string
	Traces     uint64  // number of traces exhibiting the repeat
	AvgRepeats float64 // avg executions per trace
	MaxRepeats uint64  // worst single-trace repeat count
	TotalMs    float64 // total DB time across those repeats
}

// NPlusOne finds statements executed >= minRepeats times within a single trace
// (the classic N+1 anti-pattern), aggregated across traces by impact.
func (s *Store) NPlusOne(ctx context.Context, tenantID string, minRepeats, limit int, from, to time.Time) ([]NPlusOneStat, error) {
	if minRepeats < 2 {
		minRepeats = 5
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q := `
SELECT db_statement, any(service_name) AS svc,
       count() AS traces, avg(cnt) AS avg_repeats, max(cnt) AS max_repeats, sum(total_ms) AS total_ms
FROM (
    SELECT trace_id, db_statement, any(service_name) AS service_name,
           count() AS cnt, sum(duration_ns) / 1e6 AS total_ms
    FROM apm.spans
    WHERE tenant_id = ? AND db_statement != '' AND start_time >= ? AND start_time <= ?
    GROUP BY trace_id, db_statement
    HAVING cnt >= ?
)
GROUP BY db_statement
ORDER BY total_ms DESC
LIMIT ?`
	rows, err := s.db.QueryContext(ctx, q, tenantID, from, to, minRepeats, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []NPlusOneStat
	for rows.Next() {
		var x NPlusOneStat
		if err := rows.Scan(&x.Statement, &x.Service, &x.Traces, &x.AvgRepeats, &x.MaxRepeats, &x.TotalMs); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}
