package storage

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/XSAM/otelsql"
	"github.com/heejune/apm/internal/otlp"
	"go.opentelemetry.io/otel/attribute"
)

type Store struct{ db *sql.DB }

func New(dsn string) (*Store, error) {
	// Convert clickhouse:// scheme to http:// since native protocol (9000)
	// has connection reset issues on macOS Docker. HTTP (8123) works reliably.
	if strings.HasPrefix(dsn, "clickhouse://") {
		dsn = strings.TrimPrefix(dsn, "clickhouse://")

		// Parse host:port/database
		parts := strings.Split(dsn, "/")
		dbName := ""
		if len(parts) > 1 {
			dbName = parts[len(parts)-1]
		}
		hostPort := parts[0]

		// Replace port 9000 with 8123 for HTTP
		if strings.HasSuffix(hostPort, ":9000") {
			hostPort = strings.TrimSuffix(hostPort, ":9000") + ":8123"
		} else if !strings.Contains(hostPort, ":") {
			// No port specified, default to 8123 for HTTP
			hostPort = hostPort + ":8123"
		}

		dsn = "http://" + hostPort + "/" + dbName
	}

	opts, err := clickhouse.ParseDSN(dsn)
	if err != nil {
		return nil, err
	}
	// Ensure we're using HTTP protocol
	opts.Protocol = clickhouse.HTTP
	// Wrap the ClickHouse connector with otelsql so every query becomes a real DB
	// span (db.system=clickhouse, db.statement) — dogfooding: the query service's
	// own ClickHouse calls show up in trace waterfalls and the DBM view. No-op
	// when no tracer provider is set (e.g., the gateway).
	db := otelsql.OpenDB(clickhouse.Connector(opts),
		otelsql.WithAttributes(attribute.String("db.system", "clickhouse")),
		otelsql.WithSpanOptions(otelsql.SpanOptions{OmitConnResetSession: true, OmitConnPrepare: true, OmitRows: true}),
	)
	if err := db.Ping(); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) InsertSpans(ctx context.Context, spans []otlp.Span) error {
	if len(spans) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO apm.spans")
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	defer stmt.Close()
	for _, sp := range spans {
		if _, err := stmt.ExecContext(ctx,
			sp.TenantID, sp.TraceID, sp.SpanID, sp.ParentSpanID,
			sp.ServiceName, sp.ServiceInstance, sp.SpanName, sp.SpanKind,
			sp.StartTime, sp.DurationNs, sp.StatusCode,
			sp.HTTPMethod, sp.HTTPRoute, sp.HTTPURL, sp.HTTPStatusCode,
			sp.DBSystem, sp.DBStatement, sp.DBName,
			sp.ResourceAttrs, sp.SpanAttrs,
		); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

type Filter struct {
	Service         string
	ErrorsOnly      bool
	MinMs           float64 // minimum duration in ms (0 = no floor)
	Query           string  // case-insensitive substring on transaction name
	From, To        time.Time
	OrderByDuration bool // slowest-first (exemplars) instead of newest-first
	Limit           int
}

type TransactionRow struct {
	TraceID         string
	ServiceName     string
	TransactionName string
	StatusCode      string
	StartTime       time.Time
	DurationNs      uint64
}

func (s *Store) ListTransactions(ctx context.Context, tenantID string, f Filter) ([]TransactionRow, error) {
	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 100
	}
	errFlag := 0
	if f.ErrorsOnly {
		errFlag = 1
	}
	var minNs uint64
	if f.MinMs > 0 {
		minNs = uint64(f.MinMs * 1e6)
	}
	like := "%" + f.Query + "%"
	// Default to a wide range so an unset window keeps the previous behavior.
	if f.From.IsZero() {
		f.From = time.Unix(0, 0)
	}
	if f.To.IsZero() {
		f.To = time.Now().Add(24 * time.Hour)
	}
	order := "start_time DESC"
	if f.OrderByDuration {
		order = "duration_ns DESC"
	}
	q := `
SELECT trace_id, service_name, span_name, status_code, start_time, duration_ns
FROM apm.spans
WHERE tenant_id = ? AND span_kind = 'SERVER'
  AND (? = '' OR service_name = ?)
  AND (? = 0 OR status_code = 'ERROR')
  AND (? = 0 OR duration_ns >= ?)
  AND (? = '' OR span_name ILIKE ?)
  AND start_time >= ? AND start_time <= ?
ORDER BY ` + order + `
LIMIT ?`
	rows, err := s.db.QueryContext(ctx, q, tenantID,
		f.Service, f.Service,
		errFlag,
		minNs, minNs,
		f.Query, like,
		f.From, f.To,
		f.Limit)
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
	const q = `
SELECT trace_id, span_id, parent_span_id, service_name, service_instance,
       span_name, span_kind, start_time, duration_ns, status_code,
       http_method, http_route, http_url, http_status_code,
       db_system, db_statement, db_name
FROM apm.spans
WHERE tenant_id = ? AND trace_id = ?
ORDER BY start_time ASC
LIMIT 1 BY span_id`
	rows, err := s.db.QueryContext(ctx, q, tenantID, traceID)
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
