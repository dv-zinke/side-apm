-- Console users for authentication + RBAC.
CREATE TABLE IF NOT EXISTS apm.users
(
    tenant_id     LowCardinality(String),
    username      String,
    salt          String,
    password_hash String,
    role          LowCardinality(String),   -- admin | editor | viewer
    created_at    DateTime64(3)
)
ENGINE = ReplacingMergeTree(created_at)
ORDER BY (tenant_id, username);
