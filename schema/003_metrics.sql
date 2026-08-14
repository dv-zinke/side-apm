CREATE TABLE IF NOT EXISTS apm.metrics
(
    tenant_id    LowCardinality(String),
    service_name LowCardinality(String),
    metric_name  LowCardinality(String),
    unit         LowCardinality(String),
    ts           DateTime64(3),
    value        Float64,
    attrs        Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY (tenant_id, toDate(ts))
ORDER BY (tenant_id, service_name, metric_name, ts)
TTL toDateTime(ts) + INTERVAL 15 DAY;
