-- Deploy/release markers, overlaid on RED charts to correlate regressions.
CREATE TABLE IF NOT EXISTS apm.deploys
(
    tenant_id   LowCardinality(String),
    ts          DateTime64(3),
    service     LowCardinality(String),
    version     String,
    description String
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (tenant_id, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY;
