-- Continuous profiling: parsed CPU/heap profiles as flame trees + top functions.
CREATE TABLE IF NOT EXISTS apm.profiles
(
    tenant_id String,
    id        String,
    ts        DateTime64(3),
    target    LowCardinality(String),
    ptype     LowCardinality(String),   -- cpu | heap
    unit      LowCardinality(String),
    samples   Int64,
    tree      String,                   -- JSON flame tree
    top       String                    -- JSON top functions
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (tenant_id, target, ts)
TTL toDateTime(ts) + INTERVAL 7 DAY;
