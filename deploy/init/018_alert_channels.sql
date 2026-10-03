-- Notification channels: where a firing alert gets delivered. type is
-- slack|webhook|pagerduty; target is the webhook URL or PagerDuty routing key.
CREATE TABLE IF NOT EXISTS apm.alert_channels
(
    tenant_id  LowCardinality(String),
    id         String,
    name       String,
    type       LowCardinality(String),   -- slack | webhook | pagerduty
    target     String,                    -- webhook URL or PagerDuty routing key
    enabled    UInt8,
    deleted    UInt8,
    updated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, id);

-- Delivery log: one row per (firing, channel) send attempt so operators can see
-- what actually went out and whether it succeeded.
CREATE TABLE IF NOT EXISTS apm.notifications
(
    tenant_id    LowCardinality(String),
    ts           DateTime64(3),
    rule_id      String,
    rule_name    String,
    channel_id   String,
    channel_name String,
    type         LowCardinality(String),
    state        LowCardinality(String),   -- firing | resolved
    ok           UInt8,
    error        String
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (tenant_id, ts)
TTL toDateTime(ts) + INTERVAL 30 DAY;

-- Route firings to channels: comma-separated channel ids on the rule.
ALTER TABLE apm.alert_rules ADD COLUMN IF NOT EXISTS channels String DEFAULT '';
