package storage

import (
	"context"
	"time"
)

type SamplingRule struct {
	ID       string
	Service  string // "*" = tenant default
	KeepRate float64
	Enabled  bool
}

type IngestStat struct {
	Tenant   string
	Ts       time.Time
	Received uint64
	Kept     uint64
	Dropped  uint64
}

func (s *Store) UpsertSamplingRule(ctx context.Context, tenantID string, r SamplingRule) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.sampling_rules (tenant_id,id,service,keep_rate,enabled,deleted,updated_at) VALUES (?,?,?,?,?,0,?)",
		tenantID, r.ID, r.Service, r.KeepRate, b2u(r.Enabled), time.Now().UTC())
	return err
}

func (s *Store) DeleteSamplingRule(ctx context.Context, tenantID, id string) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.sampling_rules (tenant_id,id,service,keep_rate,enabled,deleted,updated_at) VALUES (?,?,'',0,0,1,?)",
		tenantID, id, time.Now().UTC())
	return err
}

func (s *Store) ListSamplingRules(ctx context.Context, tenantID string) ([]SamplingRule, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, service, keep_rate, enabled
FROM apm.sampling_rules FINAL
WHERE tenant_id = ? AND deleted = 0
ORDER BY service`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SamplingRule
	for rows.Next() {
		var r SamplingRule
		var en uint8
		if err := rows.Scan(&r.ID, &r.Service, &r.KeepRate, &en); err != nil {
			return nil, err
		}
		r.Enabled = en == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

// AllSamplingRules returns every tenant's rules — used by the gateway sampler,
// which evaluates across tenants in one process.
func (s *Store) AllSamplingRules(ctx context.Context) (map[string][]SamplingRule, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT tenant_id, id, service, keep_rate, enabled
FROM apm.sampling_rules FINAL
WHERE deleted = 0`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]SamplingRule{}
	for rows.Next() {
		var tenant string
		var r SamplingRule
		var en uint8
		if err := rows.Scan(&tenant, &r.ID, &r.Service, &r.KeepRate, &en); err != nil {
			return nil, err
		}
		r.Enabled = en == 1
		out[tenant] = append(out[tenant], r)
	}
	return out, rows.Err()
}

func (s *Store) InsertIngestStat(ctx context.Context, st IngestStat) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.ingest_stats (tenant_id,ts,received,kept,dropped) VALUES (?,?,?,?,?)",
		st.Tenant, st.Ts, st.Received, st.Kept, st.Dropped)
	return err
}

// IngestStats returns per-minute received/kept/dropped over the window.
func (s *Store) IngestStats(ctx context.Context, tenantID string, from, to time.Time) ([]IngestStat, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT toStartOfMinute(ts) AS m, sum(received), sum(kept), sum(dropped)
FROM apm.ingest_stats
WHERE tenant_id = ? AND ts >= ? AND ts <= ?
GROUP BY m ORDER BY m`, tenantID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []IngestStat
	for rows.Next() {
		var st IngestStat
		if err := rows.Scan(&st.Ts, &st.Received, &st.Kept, &st.Dropped); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}
