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
func (s *Store) TopQueries(ctx context.Context, tenantID, orderBy string, from, to time.Time, limit int) ([]QueryStat, error) {
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
GROUP BY service_name, db_statement
ORDER BY ` + order + ` DESC
LIMIT ?`
	rows, err := s.db.QueryContext(ctx, q, tenantID, from, to, limit)
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
