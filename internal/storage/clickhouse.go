package storage

import (
	"context"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/heejune/apm/internal/otlp"
)

type Store struct{ conn driver.Conn }

func New(dsn string) (*Store, error) {
	opts, err := clickhouse.ParseDSN(dsn)
	if err != nil {
		return nil, err
	}
	conn, err := clickhouse.Open(opts)
	if err != nil {
		return nil, err
	}
	return &Store{conn: conn}, nil
}

func (s *Store) InsertSpans(ctx context.Context, spans []otlp.Span) error {
	if len(spans) == 0 {
		return nil
	}
	batch, err := s.conn.PrepareBatch(ctx, `INSERT INTO apm.spans`)
	if err != nil {
		return err
	}
	for _, sp := range spans {
		if err := batch.Append(
			sp.TenantID, sp.TraceID, sp.SpanID, sp.ParentSpanID,
			sp.ServiceName, sp.ServiceInstance, sp.SpanName, sp.SpanKind,
			sp.StartTime, sp.DurationNs, sp.StatusCode,
			sp.HTTPMethod, sp.HTTPRoute, sp.HTTPURL, sp.HTTPStatusCode,
			sp.DBSystem, sp.DBStatement, sp.DBName,
			sp.ResourceAttrs, sp.SpanAttrs,
		); err != nil {
			return err
		}
	}
	return batch.Send()
}

type Filter struct {
	Service string
	Limit   int
}

type TransactionRow struct {
	TraceID         string
	ServiceName     string
	TransactionName string
	StatusCode      string
	StartTime       time.Time
	DurationNs      uint64
}

// Phase 1: trace_summary MV가 없으므로 SERVER 스팬을 트랜잭션으로 간주.
func (s *Store) ListTransactions(ctx context.Context, tenantID string, f Filter) ([]TransactionRow, error) {
	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 100
	}
	q := `
SELECT trace_id, service_name, span_name, status_code, start_time, duration_ns
FROM apm.spans
WHERE tenant_id = ? AND span_kind = 'SERVER'
  AND (? = '' OR service_name = ?)
ORDER BY start_time DESC
LIMIT ?`
	rows, err := s.conn.Query(ctx, q, tenantID, f.Service, f.Service, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TransactionRow
	for rows.Next() {
		var r TransactionRow
		if err := rows.Scan(&r.TraceID, &r.ServiceName, &r.TransactionName,
			&r.StatusCode, &r.StartTime, &r.DurationNs); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) GetTraceSpans(ctx context.Context, tenantID, traceID string) ([]otlp.Span, error) {
	q := `
SELECT trace_id, span_id, parent_span_id, service_name, service_instance,
       span_name, span_kind, start_time, duration_ns, status_code,
       http_method, http_route, http_url, http_status_code,
       db_system, db_statement, db_name
FROM apm.spans
WHERE tenant_id = ? AND trace_id = ?
ORDER BY start_time ASC`
	rows, err := s.conn.Query(ctx, q, tenantID, traceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []otlp.Span
	for rows.Next() {
		var sp otlp.Span
		sp.TenantID = tenantID
		if err := rows.Scan(&sp.TraceID, &sp.SpanID, &sp.ParentSpanID, &sp.ServiceName,
			&sp.ServiceInstance, &sp.SpanName, &sp.SpanKind, &sp.StartTime, &sp.DurationNs,
			&sp.StatusCode, &sp.HTTPMethod, &sp.HTTPRoute, &sp.HTTPURL, &sp.HTTPStatusCode,
			&sp.DBSystem, &sp.DBStatement, &sp.DBName); err != nil {
			return nil, err
		}
		out = append(out, sp)
	}
	return out, rows.Err()
}
