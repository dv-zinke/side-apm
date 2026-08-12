CREATE TABLE IF NOT EXISTS apm.spans
(
    tenant_id           LowCardinality(String),
    trace_id            String,
    span_id             String,
    parent_span_id      String,
    service_name        LowCardinality(String),
    service_instance    LowCardinality(String),
    span_name           String,
    span_kind           Enum8('UNSPECIFIED'=0,'INTERNAL'=1,'SERVER'=2,'CLIENT'=3,'PRODUCER'=4,'CONSUMER'=5),
    start_time          DateTime64(9),
    duration_ns         UInt64,
    status_code         Enum8('UNSET'=0,'OK'=1,'ERROR'=2),
    http_method         LowCardinality(String),
    http_route          String,
    http_url            String,
    http_status_code    UInt16,
    db_system           LowCardinality(String),
    db_statement        String,
    db_name             String,
    resource_attrs      Map(LowCardinality(String), String),
    span_attrs          Map(LowCardinality(String), String),
    INDEX idx_trace trace_id TYPE bloom_filter GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY (tenant_id, toDate(start_time))
ORDER BY (tenant_id, service_name, start_time)
TTL toDateTime(start_time) + INTERVAL 15 DAY;
