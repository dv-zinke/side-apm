-- Mobile app monitoring events (iOS/Android): launches, screens, crashes,
-- network calls, non-fatal errors.
CREATE TABLE IF NOT EXISTS apm.app_events
(
    tenant_id   LowCardinality(String),
    ts          DateTime64(3),
    session_id  String,
    app_version LowCardinality(String),
    platform    LowCardinality(String),   -- ios | android
    os_version  LowCardinality(String),
    device      LowCardinality(String),
    event_type  LowCardinality(String),   -- launch | screen | crash | network | error
    screen      String,
    duration_ms Float64,
    launch_type LowCardinality(String),    -- cold | warm
    message     String,
    err_stack   String,
    url         String,
    status      UInt16,
    fatal       UInt8
)
ENGINE = MergeTree
PARTITION BY (tenant_id, toDate(ts))
ORDER BY (tenant_id, event_type, ts)
TTL toDateTime(ts) + INTERVAL 15 DAY;
