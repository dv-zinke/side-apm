package storage

import (
	"context"
	"time"

	"github.com/heejune/apm/internal/otlp"
)

func (s *Store) InsertLogs(ctx context.Context, ls []otlp.LogRecord) error {
	if len(ls) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO apm.logs")
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	for _, l := range ls {
		if _, err := stmt.ExecContext(ctx,
			l.TenantID, l.Time, l.ServiceName, l.Severity, l.Body, l.TraceID, l.SpanID, l.Attrs,
		); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

type LogRow struct {
	Time     time.Time
	Service  string
	Severity string
	Body     string
	TraceID  string
	SpanID   string
}

func scanLogs(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
}) ([]LogRow, error) {
	var out []LogRow
	for rows.Next() {
		var l LogRow
		if err := rows.Scan(&l.Time, &l.Service, &l.Severity, &l.Body, &l.TraceID, &l.SpanID); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// GetTraceLogs returns logs correlated to a trace (the 3-pillars join).
func (s *Store) GetTraceLogs(ctx context.Context, tenantID, traceID string) ([]LogRow, error) {
	const q = `
SELECT ts, service_name, severity, body, trace_id, span_id
FROM apm.logs
WHERE tenant_id = ? AND trace_id = ?
ORDER BY ts ASC
LIMIT 1000`
	rows, err := s.db.QueryContext(ctx, q, tenantID, traceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanLogs(rows)
}

type LogFilter struct {
	Service    string
	Severity   string // "" = all; else exact (ERROR/WARN/INFO/…)
	Query      string // substring on body
	Limit      int
	From, To   time.Time
}

func (s *Store) ListLogs(ctx context.Context, tenantID string, f LogFilter) ([]LogRow, error) {
	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 200
	}
	like := "%" + f.Query + "%"
	const q = `
SELECT ts, service_name, severity, body, trace_id, span_id
FROM apm.logs
WHERE tenant_id = ? AND ts >= ? AND ts <= ?
  AND (? = '' OR service_name = ?)
  AND (? = '' OR upper(severity) = upper(?))
  AND (? = '' OR body ILIKE ?)
ORDER BY ts DESC
LIMIT ?`
	rows, err := s.db.QueryContext(ctx, q, tenantID, f.From, f.To,
		f.Service, f.Service, f.Severity, f.Severity, f.Query, like, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanLogs(rows)
}

type LogPattern struct {
	Pattern  string
	Sample   string
	Count    uint64
	Errors   uint64
	Services []string
	LastSeen time.Time
}

// LogPatterns clusters raw log lines into normalized templates (numbers, hex
// ids, quoted strings, IPs → placeholders) so millions of lines collapse into a
// handful of actionable patterns. severity="" scans all levels.
func (s *Store) LogPatterns(ctx context.Context, tenantID, severity string, from, to time.Time, limit int) ([]LogPattern, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	args := []any{tenantID, from, to}
	sevFilter := ""
	if severity != "" {
		sevFilter = "AND upper(severity) = upper(?)"
		args = append(args, severity)
	}
	args = append(args, limit)
	q := `
SELECT
  replaceRegexpAll(
    replaceRegexpAll(
      replaceRegexpAll(
        replaceRegexpAll(body, '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b', '<ip>'),
        '\b[0-9a-fA-F]{8,}\b', '<id>'),
      '"[^"]*"', '<str>'),
    '\b[0-9]+\b', '<n>') AS pattern,
  count() AS cnt,
  countIf(severity = 'ERROR') AS errs,
  argMax(body, ts) AS sample,
  groupUniqArray(5)(service_name) AS svcs,
  max(ts) AS last_seen
FROM apm.logs
WHERE tenant_id = ? AND ts >= ? AND ts <= ? ` + sevFilter + `
GROUP BY pattern
ORDER BY cnt DESC
LIMIT ?`
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LogPattern
	for rows.Next() {
		var p LogPattern
		if err := rows.Scan(&p.Pattern, &p.Count, &p.Errors, &p.Sample, &p.Services, &p.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
