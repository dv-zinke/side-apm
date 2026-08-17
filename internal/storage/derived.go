package storage

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

type TraceSummaryRow struct {
	TraceID         string
	EntryService    string
	TransactionName string
	RootHTTPStatus  uint16
	StartTime       time.Time
	DurationMs      float64
	SpanCount       uint64
	ErrorCount      uint64
	SqlCount        uint64
	HttpCallCount   uint64
	SqlTimeMs       float64
	HttpCallTimeMs  float64
}

func (s *Store) GetTraceSummary(ctx context.Context, tenantID, traceID string) (TraceSummaryRow, error) {
	// ClickHouse 24.8: arithmetic on -Merge results must happen in an outer query;
	// dividing merged UInt64 values inline with / 1e6 triggers ILLEGAL_TYPE_OF_ARGUMENT.
	const q = `
SELECT
    entry_service,
    transaction_name,
    root_http_status,
    start_ns,
    (end_ns - start_ns) / 1e6  AS duration_ms,
    span_count,
    error_count,
    sql_count,
    http_call_count,
    sql_time_ns / 1e6          AS sql_ms,
    http_call_time_ns / 1e6    AS http_ms
FROM (
    SELECT
        anyIfMerge(entry_service)      AS entry_service,
        anyIfMerge(transaction_name)   AS transaction_name,
        anyIfMerge(root_http_status)   AS root_http_status,
        minMerge(start_ns)             AS start_ns,
        maxMerge(end_ns)               AS end_ns,
        countMerge(span_count)         AS span_count,
        sumMerge(error_count)          AS error_count,
        sumMerge(sql_count)            AS sql_count,
        sumMerge(http_call_count)      AS http_call_count,
        sumMerge(sql_time_ns)          AS sql_time_ns,
        sumMerge(http_call_time_ns)    AS http_call_time_ns
    FROM apm.trace_summary
    WHERE tenant_id = ? AND trace_id = ?
    GROUP BY tenant_id, trace_id
)`
	var r TraceSummaryRow
	var startNs uint64
	row := s.db.QueryRowContext(ctx, q, tenantID, traceID)
	if err := row.Scan(&r.EntryService, &r.TransactionName, &r.RootHTTPStatus,
		&startNs, &r.DurationMs, &r.SpanCount, &r.ErrorCount, &r.SqlCount,
		&r.HttpCallCount, &r.SqlTimeMs, &r.HttpCallTimeMs); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return TraceSummaryRow{TraceID: traceID}, nil
		}
		return TraceSummaryRow{}, err
	}
	r.TraceID = traceID
	r.StartTime = time.Unix(0, int64(startNs)).UTC()
	return r, nil
}

type REDPoint struct {
	Minute       time.Time
	RequestCount uint64
	ErrorCount   uint64
	P50Ms        float64
	P95Ms        float64
	P99Ms        float64
}

func (s *Store) ListServices(ctx context.Context, tenantID string) ([]string, error) {
	// Only services with traffic in the last 24h — stale/test services from long
	// ago shouldn't pollute dropdowns or become the default selection.
	rows, err := s.db.QueryContext(ctx,
		`SELECT DISTINCT service_name FROM apm.red_rollup
		 WHERE tenant_id = ? AND minute >= now() - INTERVAL 24 HOUR
		 ORDER BY service_name`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (s *Store) GetServiceRED(ctx context.Context, tenantID, service string, from, to time.Time) ([]REDPoint, error) {
	const q = `
SELECT
    minute,
    countMerge(request_count),
    sumMerge(error_count),
    quantilesMerge(0.5, 0.95, 0.99)(duration_q) AS qs
FROM apm.red_rollup
WHERE tenant_id = ? AND service_name = ? AND minute >= ? AND minute <= ?
GROUP BY minute
ORDER BY minute`
	rows, err := s.db.QueryContext(ctx, q, tenantID, service, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []REDPoint
	for rows.Next() {
		var p REDPoint
		var qs []float64
		if err := rows.Scan(&p.Minute, &p.RequestCount, &p.ErrorCount, &qs); err != nil {
			return nil, err
		}
		if len(qs) == 3 {
			p.P50Ms, p.P95Ms, p.P99Ms = qs[0]/1e6, qs[1]/1e6, qs[2]/1e6
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

type ServiceAvail struct {
	Service  string
	TotalReq uint64
	TotalErr uint64
	P95Ms    float64
}

// ServiceAvailabilities returns request/error totals + p95 latency per service
// over the window in a SINGLE aggregate query. This replaced the SLO endpoint's
// N-per-service RED+Apdex scans (found slow by self-tracing) — one query serves
// the whole SLO view, staying fast even under concurrent load.
func (s *Store) ServiceAvailabilities(ctx context.Context, tenantID string, from, to time.Time) ([]ServiceAvail, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT service_name, countMerge(request_count), sumMerge(error_count),
       quantilesMerge(0.5, 0.95, 0.99)(duration_q) AS qs
FROM apm.red_rollup
WHERE tenant_id = ? AND minute >= ? AND minute <= ?
GROUP BY service_name
ORDER BY service_name`, tenantID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ServiceAvail
	for rows.Next() {
		var a ServiceAvail
		var qs []float64
		if err := rows.Scan(&a.Service, &a.TotalReq, &a.TotalErr, &qs); err != nil {
			return nil, err
		}
		if len(qs) == 3 {
			a.P95Ms = qs[1] / 1e6
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// AllServicesRED returns every service's per-minute RED series in ONE query,
// grouped by service — so views that scan all services (health, anomalies) run a
// single aggregate instead of N per-service queries.
func (s *Store) AllServicesRED(ctx context.Context, tenantID string, from, to time.Time) (map[string][]REDPoint, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT service_name, minute,
       countMerge(request_count), sumMerge(error_count),
       quantilesMerge(0.5, 0.95, 0.99)(duration_q) AS qs
FROM apm.red_rollup
WHERE tenant_id = ? AND minute >= ? AND minute <= ?
GROUP BY service_name, minute
ORDER BY service_name, minute`, tenantID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]REDPoint{}
	for rows.Next() {
		var svc string
		var p REDPoint
		var qs []float64
		if err := rows.Scan(&svc, &p.Minute, &p.RequestCount, &p.ErrorCount, &qs); err != nil {
			return nil, err
		}
		if len(qs) == 3 {
			p.P50Ms, p.P95Ms, p.P99Ms = qs[0]/1e6, qs[1]/1e6, qs[2]/1e6
		}
		out[svc] = append(out[svc], p)
	}
	return out, rows.Err()
}
