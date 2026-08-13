package storage

import (
	"context"
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
		return TraceSummaryRow{}, err
	}
	r.TraceID = traceID
	r.StartTime = time.Unix(0, int64(startNs)).UTC()
	return r, nil
}
