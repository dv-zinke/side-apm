-- red_rollup_1h: hourly RED, the "frozen" metrics tier. Fed straight from spans
-- (like red_rollup but toStartOfHour), so it accumulates in real time and
-- survives the raw-span TTL. Retained 24 months for long-range trend queries;
-- monthly partitions keep the partition count bounded (~24 per tenant).
CREATE TABLE IF NOT EXISTS apm.red_rollup_1h
(
    tenant_id      LowCardinality(String),
    service_name   LowCardinality(String),
    hour           DateTime,
    request_count  AggregateFunction(count),
    error_count    AggregateFunction(sum, UInt64),
    duration_q     AggregateFunction(quantiles(0.5, 0.95, 0.99), UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY (tenant_id, toYYYYMM(hour))
ORDER BY (tenant_id, service_name, hour)
TTL hour + INTERVAL 730 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS apm.red_rollup_1h_mv TO apm.red_rollup_1h AS
SELECT
    tenant_id, service_name,
    toStartOfHour(start_time)                       AS hour,
    countState()                                    AS request_count,
    sumState(toUInt64(status_code = 'ERROR'))       AS error_count,
    quantilesState(0.5, 0.95, 0.99)(duration_ns)    AS duration_q
FROM apm.spans
WHERE span_kind = 'SERVER'
GROUP BY tenant_id, service_name, hour;
