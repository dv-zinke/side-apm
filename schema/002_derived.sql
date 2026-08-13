-- trace_summary: one aggregated row per (tenant, trace). Populated from spans inserts.
CREATE TABLE IF NOT EXISTS apm.trace_summary
(
    tenant_id          LowCardinality(String),
    trace_id           String,
    entry_service      AggregateFunction(anyIf, LowCardinality(String), UInt8),
    transaction_name   AggregateFunction(anyIf, String, UInt8),
    root_http_status   AggregateFunction(anyIf, UInt16, UInt8),
    start_ns           AggregateFunction(min, UInt64),
    end_ns             AggregateFunction(max, UInt64),
    span_count         AggregateFunction(count),
    error_count        AggregateFunction(sum, UInt64),
    sql_count          AggregateFunction(sum, UInt64),
    sql_time_ns        AggregateFunction(sum, UInt64),
    http_call_count    AggregateFunction(sum, UInt64),
    http_call_time_ns  AggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY tenant_id
ORDER BY (tenant_id, trace_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS apm.trace_summary_mv TO apm.trace_summary AS
SELECT
    tenant_id, trace_id,
    anyIfState(service_name, parent_span_id = '')                                  AS entry_service,
    anyIfState(http_route,   parent_span_id = '')                                  AS transaction_name,
    anyIfState(http_status_code, parent_span_id = '')                              AS root_http_status,
    minState(toUInt64(toUnixTimestamp64Nano(start_time)))                          AS start_ns,
    maxState(toUInt64(toUnixTimestamp64Nano(start_time)) + duration_ns)            AS end_ns,
    countState()                                                                   AS span_count,
    sumState(toUInt64(status_code = 'ERROR'))                                      AS error_count,
    sumState(toUInt64(span_kind = 'CLIENT' AND db_system != ''))                   AS sql_count,
    sumIfState(duration_ns, span_kind = 'CLIENT' AND db_system != '')              AS sql_time_ns,
    sumState(toUInt64(span_kind = 'CLIENT' AND db_system = ''))                    AS http_call_count,
    sumIfState(duration_ns, span_kind = 'CLIENT' AND db_system = '')               AS http_call_time_ns
FROM apm.spans
GROUP BY tenant_id, trace_id;

-- red_rollup: per (tenant, service, minute) request/error/duration on SERVER spans.
CREATE TABLE IF NOT EXISTS apm.red_rollup
(
    tenant_id      LowCardinality(String),
    service_name   LowCardinality(String),
    minute         DateTime,
    request_count  AggregateFunction(count),
    error_count    AggregateFunction(sum, UInt64),
    duration_q     AggregateFunction(quantiles(0.5, 0.95, 0.99), UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY (tenant_id, toDate(minute))
ORDER BY (tenant_id, service_name, minute);

CREATE MATERIALIZED VIEW IF NOT EXISTS apm.red_rollup_mv TO apm.red_rollup AS
SELECT
    tenant_id, service_name,
    toStartOfMinute(start_time)                     AS minute,
    countState()                                    AS request_count,
    sumState(toUInt64(status_code = 'ERROR'))       AS error_count,
    quantilesState(0.5, 0.95, 0.99)(duration_ns)    AS duration_q
FROM apm.spans
WHERE span_kind = 'SERVER'
GROUP BY tenant_id, service_name, minute;
