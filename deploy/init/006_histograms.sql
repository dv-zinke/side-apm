-- Explicit-bucket latency histograms (delta temporality). Bounds has one fewer
-- element than counts; the trailing count is the +Inf bucket. Aggregating these
-- over a window gives server-side Apdex and percentiles from real distributions.
CREATE TABLE IF NOT EXISTS apm.metric_histograms
(
    tenant_id    LowCardinality(String),
    service_name LowCardinality(String),
    metric_name  LowCardinality(String),
    unit         LowCardinality(String),
    ts           DateTime64(3),
    bounds       Array(Float64),
    counts       Array(UInt64),
    sum          Float64,
    count        UInt64
)
ENGINE = MergeTree
PARTITION BY (tenant_id, toDate(ts))
ORDER BY (tenant_id, service_name, metric_name, ts)
TTL toDateTime(ts) + INTERVAL 15 DAY;
