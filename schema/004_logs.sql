CREATE TABLE IF NOT EXISTS apm.logs
(
    tenant_id    LowCardinality(String),
    ts           DateTime64(9),
    service_name LowCardinality(String),
    severity     LowCardinality(String),
    body         String,
    trace_id     String,
    span_id      String,
    attrs        Map(LowCardinality(String), String),
    INDEX idx_trace trace_id TYPE bloom_filter GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY (tenant_id, toDate(ts))
ORDER BY (tenant_id, service_name, ts)
TTL toDateTime(ts) + INTERVAL 15 DAY;
