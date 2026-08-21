package storage

import (
	"context"
	"time"
)

type AlertChannel struct {
	ID      string
	Name    string
	Type    string // slack | webhook | pagerduty
	Target  string // webhook URL or PagerDuty routing key
	Enabled bool
}

type Notification struct {
	Ts          time.Time
	RuleID      string
	RuleName    string
	ChannelID   string
	ChannelName string
	Type        string
	State       string
	OK          bool
	Error       string
}

func (s *Store) UpsertChannel(ctx context.Context, tenantID string, c AlertChannel) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.alert_channels (tenant_id,id,name,type,target,enabled,deleted,updated_at) VALUES (?,?,?,?,?,?,0,?)",
		tenantID, c.ID, c.Name, c.Type, c.Target, b2u(c.Enabled), time.Now().UTC(),
	)
	return err
}

func (s *Store) DeleteChannel(ctx context.Context, tenantID, id string) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.alert_channels (tenant_id,id,name,type,target,enabled,deleted,updated_at) VALUES (?,?,'','','',0,1,?)",
		tenantID, id, time.Now().UTC(),
	)
	return err
}

func (s *Store) ListChannels(ctx context.Context, tenantID string) ([]AlertChannel, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, name, type, target, enabled
FROM apm.alert_channels FINAL
WHERE tenant_id = ? AND deleted = 0
ORDER BY name`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AlertChannel
	for rows.Next() {
		var c AlertChannel
		var en uint8
		if err := rows.Scan(&c.ID, &c.Name, &c.Type, &c.Target, &en); err != nil {
			return nil, err
		}
		c.Enabled = en == 1
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) InsertNotification(ctx context.Context, tenantID string, n Notification) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO apm.notifications (tenant_id,ts,rule_id,rule_name,channel_id,channel_name,type,state,ok,error) VALUES (?,?,?,?,?,?,?,?,?,?)",
		tenantID, n.Ts, n.RuleID, n.RuleName, n.ChannelID, n.ChannelName, n.Type, n.State, b2u(n.OK), n.Error,
	)
	return err
}

func (s *Store) ListNotifications(ctx context.Context, tenantID string, limit int) ([]Notification, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT ts, rule_id, rule_name, channel_id, channel_name, type, state, ok, error
FROM apm.notifications
WHERE tenant_id = ?
ORDER BY ts DESC
LIMIT ?`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Notification
	for rows.Next() {
		var n Notification
		var ok uint8
		if err := rows.Scan(&n.Ts, &n.RuleID, &n.RuleName, &n.ChannelID, &n.ChannelName, &n.Type, &n.State, &ok, &n.Error); err != nil {
			return nil, err
		}
		n.OK = ok == 1
		out = append(out, n)
	}
	return out, rows.Err()
}
