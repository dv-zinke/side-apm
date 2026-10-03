package storage

import (
	"context"
	"time"
)

type Profile struct {
	ID      string
	Time    time.Time
	Target  string
	Type    string
	Unit    string
	Samples int64
	Tree    string // JSON
	Top     string // JSON
}

func (s *Store) InsertProfile(ctx context.Context, tenantID string, p Profile) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.profiles (tenant_id,id,ts,target,ptype,unit,samples,tree,top) VALUES (?,?,?,?,?,?,?,?,?)",
		tenantID, p.ID, p.Time, p.Target, p.Type, p.Unit, p.Samples, p.Tree, p.Top)
	return err
}

type ProfileMeta struct {
	ID      string
	Time    time.Time
	Target  string
	Type    string
	Unit    string
	Samples int64
}

// ListProfiles returns recent profile metadata (no heavy tree payload).
func (s *Store) ListProfiles(ctx context.Context, tenantID string, from, to time.Time, limit int) ([]ProfileMeta, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT id, ts, target, ptype, unit, samples FROM apm.profiles
WHERE tenant_id = ? AND ts >= ? AND ts <= ?
ORDER BY ts DESC LIMIT ?`, tenantID, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProfileMeta
	for rows.Next() {
		var m ProfileMeta
		if err := rows.Scan(&m.ID, &m.Time, &m.Target, &m.Type, &m.Unit, &m.Samples); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetProfile returns one profile's flame tree + top functions JSON.
func (s *Store) GetProfile(ctx context.Context, tenantID, id string) (tree, top, unit, ptype string, err error) {
	row := s.db.QueryRowContext(ctx,
		"SELECT tree, top, unit, ptype FROM apm.profiles WHERE tenant_id = ? AND id = ? LIMIT 1", tenantID, id)
	err = row.Scan(&tree, &top, &unit, &ptype)
	return
}
