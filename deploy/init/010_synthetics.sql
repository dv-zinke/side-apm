-- Synthetic uptime checks: results of periodic HTTP probes against monitored URLs.
CREATE TABLE IF NOT EXISTS apm.synthetic_checks
(
    tenant_id  LowCardinality(String),
    ts         DateTime64(3),
    monitor    LowCardinality(String),
    url        String,
    status     UInt16,
    up         UInt8,
    latency_ms Float64,
    err        String
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (tenant_id, monitor, ts)
TTL toDateTime(ts) + INTERVAL 30 DAY;
