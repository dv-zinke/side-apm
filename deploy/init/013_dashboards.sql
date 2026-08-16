-- User-defined custom dashboards (panel layouts stored as JSON spec).
CREATE TABLE IF NOT EXISTS apm.dashboards
(
    tenant_id  LowCardinality(String),
    id         String,
    name       String,
    spec       String,          -- JSON: { panels: [...] }
    updated_at DateTime64(3),
    deleted    UInt8 DEFAULT 0
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, id);
