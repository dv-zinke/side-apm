-- Per-issue triage state for the error inbox (like Sentry/DD resolve/ignore).
-- Keyed by fingerprint = hash(service, operation, errorType). ReplacingMergeTree
-- keeps the latest status by updated_at. A resolved issue that keeps occurring
-- after updated_at is surfaced as "regressed" (computed at read time).
CREATE TABLE IF NOT EXISTS apm.error_status
(
    tenant_id   LowCardinality(String),
    fingerprint String,
    status      LowCardinality(String),   -- active | resolved | ignored
    updated_at  DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (tenant_id, fingerprint);
