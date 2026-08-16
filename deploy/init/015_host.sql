-- Host-level metrics (from dockermon reading /proc).
CREATE TABLE IF NOT EXISTS apm.host_stats
(
    tenant_id          LowCardinality(String),
    ts                 DateTime64(3),
    cpu_pct            Float64,
    mem_used           UInt64,
    mem_total          UInt64,
    mem_pct            Float64,
    ncpu               UInt16,
    load1              Float64,
    containers_running UInt16,
    containers_total   UInt16
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (tenant_id, ts)
TTL toDateTime(ts) + INTERVAL 7 DAY;
