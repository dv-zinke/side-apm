-- Tail-ish sampling: per-service keep rate (service '*' = tenant default). Errors
-- and slow spans are always kept regardless (priority keep), so sampling never
-- hides problems. No rules → keep everything (opt-in, safe default).
CREATE TABLE IF NOT EXISTS apm.sampling_rules
(
    tenant_id  LowCardinality(String),
    id         String,
    service    LowCardinality(String),
    keep_rate  Float64,
    enabled    UInt8,
    deleted    UInt8,
    updated_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, id);

-- Ingest volume accounting: received vs kept vs dropped, for the drop-rate chart.
CREATE TABLE IF NOT EXISTS apm.ingest_stats
(
    tenant_id LowCardinality(String),
    ts        DateTime64(3),
    received  UInt64,
    kept      UInt64,
    dropped   UInt64
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (tenant_id, ts)
TTL toDateTime(ts) + INTERVAL 7 DAY;
