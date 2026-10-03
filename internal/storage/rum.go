package storage

import (
	"context"
	"time"
)

type RumEvent struct {
	TenantID  string
	Time      time.Time
	SessionID string
	Type      string
	Page      string
	Target    string
	Message   string
	ErrStack  string
	Metric    string
	Value     float64
	URL       string
	Status    uint16
	UA        string
	Attrs     map[string]string
}

func (s *Store) InsertRumEvents(ctx context.Context, evs []RumEvent) error {
	if len(evs) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO apm.rum_events")
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	for _, e := range evs {
		if e.Attrs == nil {
			e.Attrs = map[string]string{}
		}
		if _, err := stmt.ExecContext(ctx,
			e.TenantID, e.Time, e.SessionID, e.Type, e.Page, e.Target, e.Message, e.ErrStack,
			e.Metric, e.Value, e.URL, e.Status, e.UA, e.Attrs,
		); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

type RumOverview struct {
	Sessions   uint64
	Pageviews  uint64
	Errors     uint64
	LCPp75     float64
	INPp75     float64
	CLSp75     float64
}

func (s *Store) RumOverview(ctx context.Context, tenantID string, from, to time.Time) (RumOverview, error) {
	var o RumOverview
	row := s.db.QueryRowContext(ctx, `
SELECT uniqExact(session_id),
       countIf(event_type = 'pageview'),
       countIf(event_type = 'error'),
       quantileIf(0.75)(value, event_type='vital' AND metric='LCP'),
       quantileIf(0.75)(value, event_type='vital' AND metric='INP'),
       quantileIf(0.75)(value, event_type='vital' AND metric='CLS')
FROM apm.rum_events
WHERE tenant_id = ? AND ts >= ? AND ts <= ?`, tenantID, from, to)
	if err := row.Scan(&o.Sessions, &o.Pageviews, &o.Errors, &o.LCPp75, &o.INPp75, &o.CLSp75); err != nil {
		return o, err
	}
	return o, nil
}

type RumCount struct {
	Key   string
	Sub   string // page or last-seen
	Count uint64
	AvgMs float64
}

// TopClicks — most-clicked targets.
func (s *Store) TopClicks(ctx context.Context, tenantID string, from, to time.Time, limit int) ([]RumCount, error) {
	return s.rumGroup(ctx, `
SELECT target, any(page), count(), 0
FROM apm.rum_events
WHERE tenant_id=? AND event_type='click' AND target != '' AND ts>=? AND ts<=?
GROUP BY target ORDER BY count() DESC LIMIT ?`, tenantID, from, to, limit)
}

// TopErrors — grouped front-end errors.
func (s *Store) TopErrors(ctx context.Context, tenantID string, from, to time.Time, limit int) ([]RumCount, error) {
	return s.rumGroup(ctx, `
SELECT message, any(page), count(), 0
FROM apm.rum_events
WHERE tenant_id=? AND event_type='error' AND message != '' AND ts>=? AND ts<=?
GROUP BY message ORDER BY count() DESC LIMIT ?`, tenantID, from, to, limit)
}

// TopResources — front-end HTTP calls by url.
func (s *Store) TopResources(ctx context.Context, tenantID string, from, to time.Time, limit int) ([]RumCount, error) {
	return s.rumGroup(ctx, `
SELECT url, toString(any(status)), count(), avg(value)
FROM apm.rum_events
WHERE tenant_id=? AND event_type='resource' AND url != '' AND ts>=? AND ts<=?
GROUP BY url ORDER BY count() DESC LIMIT ?`, tenantID, from, to, limit)
}

type RumReplay struct {
	ID        string
	Time      time.Time
	SessionID string
	Page      string
	Message   string
	Events    string // JSON array of rrweb events
}

func (s *Store) InsertRumReplay(ctx context.Context, tenantID string, r RumReplay) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.rum_replays (tenant_id,id,ts,session_id,page,message,events) VALUES (?,?,?,?,?,?,?)",
		tenantID, r.ID, r.Time, r.SessionID, r.Page, r.Message, r.Events)
	return err
}

type ReplayMeta struct {
	ID        string
	Time      time.Time
	SessionID string
	Page      string
	Message   string
}

// ListReplays returns replay metadata (without the heavy events payload).
func (s *Store) ListReplays(ctx context.Context, tenantID string, from, to time.Time, limit int) ([]ReplayMeta, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT id, ts, session_id, page, message
FROM apm.rum_replays
WHERE tenant_id = ? AND ts >= ? AND ts <= ?
ORDER BY ts DESC LIMIT ?`, tenantID, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ReplayMeta
	for rows.Next() {
		var m ReplayMeta
		if err := rows.Scan(&m.ID, &m.Time, &m.SessionID, &m.Page, &m.Message); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetReplay returns the rrweb events JSON for one replay.
func (s *Store) GetReplay(ctx context.Context, tenantID, id string) (string, error) {
	var events string
	err := s.db.QueryRowContext(ctx,
		"SELECT events FROM apm.rum_replays WHERE tenant_id = ? AND id = ? LIMIT 1", tenantID, id).Scan(&events)
	return events, err
}

func (s *Store) rumGroup(ctx context.Context, q, tenantID string, from, to time.Time, limit int) ([]RumCount, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, q, tenantID, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RumCount
	for rows.Next() {
		var c RumCount
		if err := rows.Scan(&c.Key, &c.Sub, &c.Count, &c.AvgMs); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
