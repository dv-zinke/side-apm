package storage

import (
	"context"
	"time"
)

type ContainerStat struct {
	TenantID  string
	Time      time.Time
	Container string
	Image     string
	Status    string
	CPUPct    float64
	MemBytes  uint64
	MemLimit  uint64
	MemPct    float64
	NetRx     uint64
	NetTx     uint64
}

func (s *Store) InsertContainerStats(ctx context.Context, cs []ContainerStat) error {
	if len(cs) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO apm.container_stats")
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	for _, c := range cs {
		if _, err := stmt.ExecContext(ctx,
			c.TenantID, c.Time, c.Container, c.Image, c.Status,
			c.CPUPct, c.MemBytes, c.MemLimit, c.MemPct, c.NetRx, c.NetTx,
		); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// ListContainers returns the latest snapshot per container in the window.
func (s *Store) ListContainers(ctx context.Context, tenantID string, from, to time.Time) ([]ContainerStat, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT container, any(image), argMax(status, ts), argMax(cpu_pct, ts),
       argMax(mem_bytes, ts), argMax(mem_limit, ts), argMax(mem_pct, ts),
       argMax(net_rx, ts), argMax(net_tx, ts), max(ts)
FROM apm.container_stats
WHERE tenant_id = ? AND ts >= ? AND ts <= ?
GROUP BY container
ORDER BY container`, tenantID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ContainerStat
	for rows.Next() {
		var c ContainerStat
		c.TenantID = tenantID
		if err := rows.Scan(&c.Container, &c.Image, &c.Status, &c.CPUPct,
			&c.MemBytes, &c.MemLimit, &c.MemPct, &c.NetRx, &c.NetTx, &c.Time); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ContainerSeries returns a metric timeseries (cpu_pct|mem_pct|mem_bytes) for one
// container, averaged into 10s buckets.
func (s *Store) ContainerSeries(ctx context.Context, tenantID, container, metric string, from, to time.Time) ([]MetricPoint, error) {
	col := "cpu_pct"
	switch metric {
	case "mem_pct":
		col = "mem_pct"
	case "mem_bytes":
		col = "mem_bytes"
	case "net_rx":
		col = "net_rx"
	case "net_tx":
		col = "net_tx"
	}
	q := `
SELECT toStartOfInterval(ts, INTERVAL 10 SECOND) AS bucket, avg(` + col + `) AS v
FROM apm.container_stats
WHERE tenant_id = ? AND container = ? AND ts >= ? AND ts <= ?
GROUP BY bucket ORDER BY bucket`
	rows, err := s.db.QueryContext(ctx, q, tenantID, container, from, to)
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

type HostStat struct {
	TenantID          string
	Time              time.Time
	CPUPct            float64
	MemUsed           uint64
	MemTotal          uint64
	MemPct            float64
	NCPU              uint16
	Load1             float64
	ContainersRunning uint16
	ContainersTotal   uint16
}

func (s *Store) InsertHostStat(ctx context.Context, h HostStat) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.host_stats (tenant_id,ts,cpu_pct,mem_used,mem_total,mem_pct,ncpu,load1,containers_running,containers_total) VALUES (?,?,?,?,?,?,?,?,?,?)",
		h.TenantID, h.Time, h.CPUPct, h.MemUsed, h.MemTotal, h.MemPct, h.NCPU, h.Load1, h.ContainersRunning, h.ContainersTotal)
	return err
}

// LatestHost returns the most recent host stats snapshot.
func (s *Store) LatestHost(ctx context.Context, tenantID string) (HostStat, bool, error) {
	var h HostStat
	h.TenantID = tenantID
	row := s.db.QueryRowContext(ctx, `
SELECT ts, cpu_pct, mem_used, mem_total, mem_pct, ncpu, load1, containers_running, containers_total
FROM apm.host_stats WHERE tenant_id = ? ORDER BY ts DESC LIMIT 1`, tenantID)
	if err := row.Scan(&h.Time, &h.CPUPct, &h.MemUsed, &h.MemTotal, &h.MemPct, &h.NCPU, &h.Load1, &h.ContainersRunning, &h.ContainersTotal); err != nil {
		return h, false, nil
	}
	return h, true, nil
}
