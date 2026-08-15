-- Container (Docker) infra metrics from the docker-stats collector.
CREATE TABLE IF NOT EXISTS apm.container_stats
(
    tenant_id  LowCardinality(String),
    ts         DateTime64(3),
    container  LowCardinality(String),
    image      LowCardinality(String),
    status     LowCardinality(String),
    cpu_pct    Float64,
    mem_bytes  UInt64,
    mem_limit  UInt64,
    mem_pct    Float64,
    net_rx     UInt64,
    net_tx     UInt64
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (tenant_id, container, ts)
TTL toDateTime(ts) + INTERVAL 7 DAY;
