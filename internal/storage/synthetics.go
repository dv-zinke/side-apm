package storage

import (
	"context"
	"strconv"
	"time"
)

type SyntheticCheck struct {
	TenantID  string
	Time      time.Time
	Monitor   string
	URL       string
	Status    uint16
	Up        uint8
	LatencyMs float64
	Err       string
}

func (s *Store) InsertSyntheticChecks(ctx context.Context, cs []SyntheticCheck) error {
	if len(cs) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO apm.synthetic_checks")
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	for _, c := range cs {
		if _, err := stmt.ExecContext(ctx, c.TenantID, c.Time, c.Monitor, c.URL, c.Status, c.Up, c.LatencyMs, c.Err); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

type MonitorStatus struct {
	Monitor      string
	URL          string
	Up           bool
	Status       uint16
	LatencyMs    float64
	Uptime       float64 // % over window
	AvgLatencyMs float64
	Checks       uint64
	LastErr      string
	LastAt       time.Time
}

// ListMonitors returns latest status + windowed uptime per monitor.
func (s *Store) ListMonitors(ctx context.Context, tenantID string, from, to time.Time) ([]MonitorStatus, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT monitor, any(url), argMax(up, ts), argMax(status, ts), argMax(latency_ms, ts),
       100 * avg(up), avg(latency_ms), count(), argMax(err, ts), max(ts)
FROM apm.synthetic_checks
WHERE tenant_id = ? AND ts >= ? AND ts <= ?
GROUP BY monitor ORDER BY monitor`, tenantID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MonitorStatus
	for rows.Next() {
		var m MonitorStatus
		var up uint8
		if err := rows.Scan(&m.Monitor, &m.URL, &up, &m.Status, &m.LatencyMs, &m.Uptime, &m.AvgLatencyMs, &m.Checks, &m.LastErr, &m.LastAt); err != nil {
			return nil, err
		}
		m.Up = up == 1
		out = append(out, m)
	}
	return out, rows.Err()
}

type UptimeBucket struct {
	Time      time.Time
	Up        uint8   // 0 if any check in the bucket failed
	LatencyMs float64
}

// MonitorTimeline buckets checks so the UI can draw an uptime bar.
func (s *Store) MonitorTimeline(ctx context.Context, tenantID, monitor string, from, to time.Time, bucketSec int) ([]UptimeBucket, error) {
	if bucketSec <= 0 {
		bucketSec = 60
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT toStartOfInterval(ts, INTERVAL `+strconv.Itoa(bucketSec)+` SECOND) AS b, min(up), avg(latency_ms)
FROM apm.synthetic_checks
WHERE tenant_id = ? AND monitor = ? AND ts >= ? AND ts <= ?
GROUP BY b ORDER BY b`, tenantID, monitor, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UptimeBucket
	for rows.Next() {
		var u UptimeBucket
		if err := rows.Scan(&u.Time, &u.Up, &u.LatencyMs); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
