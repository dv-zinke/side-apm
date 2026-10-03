-- Real-user monitoring events from the browser (pageview/click/error/vital/resource).
CREATE TABLE IF NOT EXISTS apm.rum_events
(
    tenant_id  LowCardinality(String),
    ts         DateTime64(3),
    session_id String,
    event_type LowCardinality(String),   -- pageview|click|error|vital|resource
    page       String,
    target     String,                   -- click target text/selector
    message    String,                   -- error message
    err_stack  String,
    metric     LowCardinality(String),   -- LCP|CLS|INP|FCP|TTFB
    value      Float64,                  -- vital value / resource duration ms
    url        String,                   -- resource url
    status     UInt16,                   -- resource http status
    ua         String,
    attrs      Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY (tenant_id, toDate(ts))
ORDER BY (tenant_id, event_type, ts)
TTL toDateTime(ts) + INTERVAL 15 DAY;
