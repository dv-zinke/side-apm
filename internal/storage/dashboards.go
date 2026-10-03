package storage

import (
	"context"
	"time"
)

type Dashboard struct {
	ID   string
	Name string
	Spec string // JSON
}

func (s *Store) UpsertDashboard(ctx context.Context, tenantID string, d Dashboard) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.dashboards (tenant_id,id,name,spec,updated_at,deleted) VALUES (?,?,?,?,?,0)",
		tenantID, d.ID, d.Name, d.Spec, time.Now().UTC())
	return err
}

func (s *Store) DeleteDashboard(ctx context.Context, tenantID, id string) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.dashboards (tenant_id,id,name,spec,updated_at,deleted) VALUES (?,?,'','',?,1)",
		tenantID, id, time.Now().UTC())
	return err
}

func (s *Store) ListDashboards(ctx context.Context, tenantID string) ([]Dashboard, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, argMax(name, updated_at), argMax(spec, updated_at)
FROM apm.dashboards WHERE tenant_id = ?
GROUP BY id HAVING argMax(deleted, updated_at) = 0
ORDER BY argMax(updated_at, updated_at) DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Dashboard
	for rows.Next() {
		var d Dashboard
		if err := rows.Scan(&d.ID, &d.Name, &d.Spec); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
