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
