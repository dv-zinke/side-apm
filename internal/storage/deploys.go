package storage

import (
	"context"
	"time"
)

type Deploy struct {
	TenantID    string
	Time        time.Time
	Service     string
	Version     string
	Description string
}

func (s *Store) InsertDeploy(ctx context.Context, tenantID string, d Deploy) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.deploys (tenant_id,ts,service,version,description) VALUES (?,?,?,?,?)",
		tenantID, d.Time, d.Service, d.Version, d.Description)
	return err
}

// DeployImpact is a deploy annotated with the service's RED before vs after it —
// the basis for regression detection (Datadog Deployment / NR Change Tracking).
type DeployImpact struct {
	Time          time.Time
	Service       string
	Version       string
	Description   string
	WindowMin     int
	BeforeReq     uint64
	AfterReq      uint64
	BeforeErrRate float64 // %
	AfterErrRate  float64 // %
	BeforeP95     float64 // ms
	AfterP95      float64 // ms
	AfterComplete bool    // false if the post-deploy window hasn't fully elapsed
}

// serviceREDAgg returns aggregate req/err/p95 for one service over a window,
// straight from the minute rollup (single row).
func (s *Store) serviceREDAgg(ctx context.Context, tenantID, service string, from, to time.Time) (req, errs uint64, p95 float64, err error) {
	row := s.db.QueryRowContext(ctx, `
SELECT countMerge(request_count), sumMerge(error_count), quantilesMerge(0.95)(duration_q) AS qs
FROM apm.red_rollup
WHERE tenant_id = ? AND service_name = ? AND minute >= ? AND minute <= ?`, tenantID, service, from, to)
	var qs []float64
	if err = row.Scan(&req, &errs, &qs); err != nil {
		return 0, 0, 0, err
	}
	if len(qs) == 1 {
		p95 = qs[0] / 1e6
	}
	return req, errs, p95, nil
}

// DeployImpacts lists recent deploys with their before/after RED comparison.
func (s *Store) DeployImpacts(ctx context.Context, tenantID, service string, windowMin, limit int) ([]DeployImpact, error) {
	if windowMin <= 0 {
		windowMin = 30
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	now := time.Now().UTC()
	deploys, err := s.ListDeploys(ctx, tenantID, service, now.Add(-180*24*time.Hour), now, limit)
	if err != nil {
		return nil, err
	}
	w := time.Duration(windowMin) * time.Minute
	out := make([]DeployImpact, 0, len(deploys))
	for _, d := range deploys {
		di := DeployImpact{Time: d.Time, Service: d.Service, Version: d.Version, Description: d.Description, WindowMin: windowMin}
		bReq, bErr, bP95, err := s.serviceREDAgg(ctx, tenantID, d.Service, d.Time.Add(-w), d.Time)
		if err != nil {
			return nil, err
		}
		aReq, aErr, aP95, err := s.serviceREDAgg(ctx, tenantID, d.Service, d.Time, d.Time.Add(w))
		if err != nil {
			return nil, err
		}
		di.BeforeReq, di.AfterReq, di.BeforeP95, di.AfterP95 = bReq, aReq, bP95, aP95
		if bReq > 0 {
			di.BeforeErrRate = 100 * float64(bErr) / float64(bReq)
		}
		if aReq > 0 {
			di.AfterErrRate = 100 * float64(aErr) / float64(aReq)
		}
		di.AfterComplete = now.After(d.Time.Add(w))
		out = append(out, di)
	}
	return out, nil
}

// ListDeploys returns deploy markers in the window (optionally for one service),
// newest first.
func (s *Store) ListDeploys(ctx context.Context, tenantID, service string, from, to time.Time, limit int) ([]Deploy, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	args := []any{tenantID, from, to}
	svcFilter := ""
	if service != "" {
		svcFilter = "AND service = ?"
		args = append(args, service)
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, `
SELECT ts, service, version, description
FROM apm.deploys
WHERE tenant_id = ? AND ts >= ? AND ts <= ? `+svcFilter+`
ORDER BY ts DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Deploy
	for rows.Next() {
		var d Deploy
		d.TenantID = tenantID
		if err := rows.Scan(&d.Time, &d.Service, &d.Version, &d.Description); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
