package storage

import (
	"context"
	"time"
)

type AppEvent struct {
	TenantID   string
	Time       time.Time
	SessionID  string
	AppVersion string
	Platform   string
	OSVersion  string
	Device     string
	Type       string
	Screen     string
	DurationMs float64
	LaunchType string
	Message    string
	ErrStack   string
	URL        string
	Status     uint16
	Fatal      uint8
}

func (s *Store) InsertAppEvents(ctx context.Context, evs []AppEvent) error {
	if len(evs) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO apm.app_events")
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	for _, e := range evs {
		if _, err := stmt.ExecContext(ctx,
			e.TenantID, e.Time, e.SessionID, e.AppVersion, e.Platform, e.OSVersion, e.Device,
			e.Type, e.Screen, e.DurationMs, e.LaunchType, e.Message, e.ErrStack, e.URL, e.Status, e.Fatal,
		); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

type AppOverview struct {
	Sessions       uint64
	CrashSessions  uint64
	CrashFreeRate  float64
	ColdStartP75   float64
	WarmStartP75   float64
	NetworkErrRate float64
}

func (s *Store) AppOverview(ctx context.Context, tenantID string, from, to time.Time) (AppOverview, error) {
	var o AppOverview
	row := s.db.QueryRowContext(ctx, `
SELECT uniqExact(session_id),
       uniqExactIf(session_id, event_type = 'crash' AND fatal = 1),
       quantileIf(0.75)(duration_ms, event_type = 'launch' AND launch_type = 'cold'),
       quantileIf(0.75)(duration_ms, event_type = 'launch' AND launch_type = 'warm'),
       100 * countIf(event_type = 'network' AND status >= 400) / greatest(countIf(event_type = 'network'), 1)
FROM apm.app_events
WHERE tenant_id = ? AND ts >= ? AND ts <= ?`, tenantID, from, to)
	if err := row.Scan(&o.Sessions, &o.CrashSessions, &o.ColdStartP75, &o.WarmStartP75, &o.NetworkErrRate); err != nil {
		return o, err
	}
	if o.Sessions > 0 {
		o.CrashFreeRate = 100 * float64(o.Sessions-o.CrashSessions) / float64(o.Sessions)
	}
	return o, nil
}

type AppVersionStat struct {
	Version       string
	Platform      string
	Sessions      uint64
	CrashFreeRate float64
}

func (s *Store) AppVersions(ctx context.Context, tenantID string, from, to time.Time, limit int) ([]AppVersionStat, error) {
	if limit <= 0 || limit > 50 {
		limit = 10
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT app_version, any(platform), uniqExact(session_id),
       100 * (uniqExact(session_id) - uniqExactIf(session_id, event_type='crash' AND fatal=1)) / greatest(uniqExact(session_id), 1)
FROM apm.app_events
WHERE tenant_id = ? AND ts >= ? AND ts <= ? AND app_version != ''
GROUP BY app_version ORDER BY uniqExact(session_id) DESC LIMIT ?`, tenantID, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AppVersionStat
	for rows.Next() {
		var v AppVersionStat
		if err := rows.Scan(&v.Version, &v.Platform, &v.Sessions, &v.CrashFreeRate); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

type AppGroup struct {
	Key   string
	Sub   string
	Count uint64
	AvgMs float64
}

func (s *Store) appGroup(ctx context.Context, q, tenantID string, from, to time.Time, limit int) ([]AppGroup, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, q, tenantID, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AppGroup
	for rows.Next() {
		var g AppGroup
		if err := rows.Scan(&g.Key, &g.Sub, &g.Count, &g.AvgMs); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// TopScreens — most-viewed screens (avg render/appear time).
func (s *Store) TopScreens(ctx context.Context, tenantID string, from, to time.Time, limit int) ([]AppGroup, error) {
	return s.appGroup(ctx, `
SELECT screen, '', count(), avg(duration_ms)
FROM apm.app_events
WHERE tenant_id=? AND event_type='screen' AND screen != '' AND ts>=? AND ts<=?
GROUP BY screen ORDER BY count() DESC LIMIT ?`, tenantID, from, to, limit)
}

// TopCrashes — grouped crashes with affected-session count (Sub).
func (s *Store) TopCrashes(ctx context.Context, tenantID string, from, to time.Time, limit int) ([]AppGroup, error) {
	return s.appGroup(ctx, `
SELECT message, toString(uniqExact(session_id)), count(), 0
FROM apm.app_events
WHERE tenant_id=? AND event_type='crash' AND message != '' AND ts>=? AND ts<=?
GROUP BY message ORDER BY count() DESC LIMIT ?`, tenantID, from, to, limit)
}

// TopAppNetwork — app→backend HTTP calls by url.
func (s *Store) TopAppNetwork(ctx context.Context, tenantID string, from, to time.Time, limit int) ([]AppGroup, error) {
	return s.appGroup(ctx, `
SELECT url, toString(any(status)), count(), avg(duration_ms)
FROM apm.app_events
WHERE tenant_id=? AND event_type='network' AND url != '' AND ts>=? AND ts<=?
GROUP BY url ORDER BY count() DESC LIMIT ?`, tenantID, from, to, limit)
}

type CrashDetail struct {
	Message  string
	Stack    string
	Sessions uint64
	Count    uint64
	Versions []string
	Devices  []string
	OSes     []string
	LastSeen time.Time
}

// CrashDetail returns stack + impact breakdown (versions/devices/os) for one
// crash signature.
func (s *Store) CrashDetail(ctx context.Context, tenantID, message string, from, to time.Time) (CrashDetail, error) {
	var d CrashDetail
	d.Message = message
	row := s.db.QueryRowContext(ctx, `
SELECT argMax(err_stack, ts), uniqExact(session_id), count(),
       groupUniqArray(8)(app_version), groupUniqArray(8)(device), groupUniqArray(8)(os_version), max(ts)
FROM apm.app_events
WHERE tenant_id = ? AND event_type = 'crash' AND message = ? AND ts >= ? AND ts <= ?`,
		tenantID, message, from, to)
	if err := row.Scan(&d.Stack, &d.Sessions, &d.Count, &d.Versions, &d.Devices, &d.OSes, &d.LastSeen); err != nil {
		return d, err
	}
	return d, nil
}
