-- Alert rules: upserted by id (ReplacingMergeTree keeps latest by updated_at).
CREATE TABLE IF NOT EXISTS apm.alert_rules
(
    tenant_id  LowCardinality(String),
    id         String,
    name       String,
    service    LowCardinality(String),
    metric     LowCardinality(String),   -- 'error_rate' | 'p95_ms'
    threshold  Float64,                   -- fire when value > threshold
    window_min UInt16,                    -- lookback window in minutes
    enabled    UInt8,
    deleted    UInt8,
    updated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, id);

-- Alert firings: append-only history of threshold breaches.
CREATE TABLE IF NOT EXISTS apm.alerts
(
    tenant_id  LowCardinality(String),
    fired_at   DateTime64(3),
    rule_id    String,
    rule_name  String,
    service    LowCardinality(String),
    metric     LowCardinality(String),
    value      Float64,
    threshold  Float64,
    state      LowCardinality(String)     -- 'firing' | 'resolved'
)
ENGINE = MergeTree
PARTITION BY toDate(fired_at)
ORDER BY (tenant_id, fired_at)
TTL toDateTime(fired_at) + INTERVAL 30 DAY;
