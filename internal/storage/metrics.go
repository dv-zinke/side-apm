package storage

import (
	"context"
	"time"

	"github.com/heejune/apm/internal/otlp"
)

func (s *Store) InsertMetrics(ctx context.Context, ms []otlp.Metric) error {
	if len(ms) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO apm.metrics")
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	for _, m := range ms {
		if _, err := stmt.ExecContext(ctx,
			m.TenantID, m.ServiceName, m.Name, m.Unit, m.Time, m.Value, m.Attrs,
		); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// ListMetricNames returns the distinct metric names seen for a service.
func (s *Store) ListMetricNames(ctx context.Context, tenantID, service string) ([]string, error) {
	const q = `
SELECT DISTINCT metric_name FROM apm.metrics
WHERE tenant_id = ? AND service_name = ?
ORDER BY metric_name`
	rows, err := s.db.QueryContext(ctx, q, tenantID, service)
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

type MetricPoint struct {
	Time  time.Time
	Value float64
}

// GetServiceMetric returns a metric's timeseries, averaged into 10s buckets.
func (s *Store) GetServiceMetric(ctx context.Context, tenantID, service, name string, from, to time.Time) ([]MetricPoint, error) {
	const q = `
SELECT toStartOfInterval(ts, INTERVAL 10 SECOND) AS bucket, avg(value) AS v
FROM apm.metrics
WHERE tenant_id = ? AND service_name = ? AND metric_name = ?
  AND ts >= ? AND ts <= ?
GROUP BY bucket
ORDER BY bucket`
	rows, err := s.db.QueryContext(ctx, q, tenantID, service, name, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MetricPoint
	for rows.Next() {
		var p MetricPoint
		if err := rows.Scan(&p.Time, &p.Value); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
