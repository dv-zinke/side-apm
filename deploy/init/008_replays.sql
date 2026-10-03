-- Session replays: rrweb event streams captured around front-end errors.
-- Kept short (7d) since payloads are large.
CREATE TABLE IF NOT EXISTS apm.rum_replays
(
    tenant_id  LowCardinality(String),
    id         String,
    ts         DateTime64(3),
    session_id String,
    page       String,
    message    String,
    events     String              -- JSON array of rrweb events
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (tenant_id, ts)
TTL toDateTime(ts) + INTERVAL 7 DAY;
