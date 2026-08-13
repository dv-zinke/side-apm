# APM Phase 2A — 파생 MV + 레코드요약 + RED 대시보드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** ClickHouse 파생 Materialized View(trace_summary, red_rollup)를 추가하고, 그 위에 와탭식 "레코드 요약"(트랜잭션 파생지표)과 서비스별 RED(Rate/Error/Duration) 대시보드를 쿼리 API + React UI로 제공한다.

**Architecture:** `spans` 원본 테이블에 대한 INSERT가 두 개의 AggregatingMergeTree MV를 자동 populate한다(writer 변경 불필요). trace_summary = (tenant,trace)당 파생 롤업(경과·SQL·HTTP호출 집계), red_rollup = (tenant,service,분)당 요청수·에러수·duration 분위수. Query Service가 `-Merge`로 읽어 새 REST 엔드포인트로 노출하고, UI가 레코드요약 패널과 RED 시계열(ECharts)을 그린다.

**Tech Stack:** ClickHouse 24.8 AggregatingMergeTree/MV, Go (clickhouse-go HTTP), React+TS, ECharts.

## Global Constraints

- Go module `github.com/heejune/apm`. Go 1.22+. Commit footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- ClickHouse client uses HTTP; `storage.New` accepts `clickhouse://host:9000/apm` and rewrites to HTTP:8123 (unchanged).
- Integration tests gated on `APM_TEST_CH_DSN` (`clickhouse://localhost:8123/apm`); fresh CH via `docker compose -f deploy/docker-compose.yml down && up -d clickhouse`, wait for `:8123` and for the post-init server restart.
- tenant_id is server-side constant `"default"` (Phase 4 adds real tenancy). Never from client input.
- DurationMs on the wire is `float64` (ns/1e6) — keep consistent with Phase 1.
- **VERIFIED DDL**: the trace_summary MV pattern below was prototyped against live ClickHouse 24.8 and confirmed (anyIfState/minState/maxState/countState/sumState/sumIfState + -Merge). Use it as given.

## File Structure

```
schema/002_derived.sql                 -- trace_summary + red_rollup tables + MVs
deploy/init/002_derived.sql            -- copy (auto-applied on fresh CH)
internal/storage/derived.go            -- TraceSummaryRow, ServiceRED types + queries
internal/storage/derived_test.go       -- integration tests (MV populate + -Merge reads)
query/derived_api.go                   -- record-summary, services, RED endpoints + DTOs
query/derived_api_test.go              -- fake-reader endpoint tests
web/src/RecordSummary.tsx              -- WhaTap 레코드요약 panel
web/src/RedDashboard.tsx               -- per-service RED time-series (ECharts)
web/src/api.ts                         -- extend with new types + fetchers (modify)
web/src/App.tsx                        -- add RED dashboard nav + record summary in detail (modify)
```

---

### Task 1: 파생 MV 스키마 (trace_summary + red_rollup)

**Files:**
- Create: `schema/002_derived.sql`
- Create: `deploy/init/002_derived.sql` (identical copy)
- Test: `internal/storage/derived_test.go` (first test only checks MVs populate)

**Interfaces:**
- Consumes: `apm.spans` (Phase 1).
- Produces: tables `apm.trace_summary`, `apm.red_rollup` + MVs `apm.trace_summary_mv`, `apm.red_rollup_mv`.

- [ ] **Step 1: Write schema DDL**

`schema/002_derived.sql`:
```sql
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
```

- [ ] **Step 2: Copy to init dir**

Run: `cp schema/002_derived.sql deploy/init/002_derived.sql`

- [ ] **Step 3: Write failing integration test (MVs populate on insert)**

`internal/storage/derived_test.go`:
```go
package storage

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/heejune/apm/internal/otlp"
)

func testStoreDerived(t *testing.T) *Store {
	dsn := os.Getenv("APM_TEST_CH_DSN")
	if dsn == "" {
		t.Skip("set APM_TEST_CH_DSN")
	}
	s, err := New(dsn)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func TestTraceSummaryPopulates(t *testing.T) {
	s := testStoreDerived(t)
	ctx := context.Background()
	now := time.Now().UTC()
	tid := "ts_" + now.Format("150405.000000000")
	spans := []otlp.Span{
		{TenantID: "default", TraceID: tid, SpanID: "r1", ParentSpanID: "", ServiceName: "SvcA",
			SpanName: "GET /p", SpanKind: "SERVER", StartTime: now, DurationNs: 200_000_000, // 200ms
			StatusCode: "OK", HTTPRoute: "/p", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
		{TenantID: "default", TraceID: tid, SpanID: "c1", ParentSpanID: "r1", ServiceName: "SvcA",
			SpanName: "SELECT", SpanKind: "CLIENT", StartTime: now, DurationNs: 30_000_000, // 30ms sql
			StatusCode: "OK", DBSystem: "postgresql", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
		{TenantID: "default", TraceID: tid, SpanID: "c2", ParentSpanID: "r1", ServiceName: "SvcA",
			SpanName: "GET", SpanKind: "CLIENT", StartTime: now, DurationNs: 50_000_000, // 50ms http
			StatusCode: "OK", HTTPURL: "http://x", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
	}
	if err := s.InsertSpans(ctx, spans); err != nil {
		t.Fatalf("insert: %v", err)
	}
	// MV fires synchronously on insert; read the summary back.
	sum, err := s.GetTraceSummary(ctx, "default", tid)
	if err != nil {
		t.Fatalf("GetTraceSummary: %v", err)
	}
	if sum.EntryService != "SvcA" || sum.TransactionName != "/p" {
		t.Errorf("entry: %q txn: %q", sum.EntryService, sum.TransactionName)
	}
	if sum.SpanCount != 3 {
		t.Errorf("span_count = %d", sum.SpanCount)
	}
	if sum.SqlCount != 1 || sum.HttpCallCount != 1 {
		t.Errorf("sql=%d http=%d", sum.SqlCount, sum.HttpCallCount)
	}
	if sum.DurationMs < 199 || sum.DurationMs > 201 {
		t.Errorf("elapsed ms = %v (want ~200)", sum.DurationMs)
	}
	if sum.SqlTimeMs < 29 || sum.SqlTimeMs > 31 {
		t.Errorf("sql ms = %v (want ~30)", sum.SqlTimeMs)
	}
}
```

- [ ] **Step 4: Run test — expect FAIL (GetTraceSummary undefined)**

Run: `export PATH="/opt/homebrew/bin:$PATH"; APM_TEST_CH_DSN="clickhouse://localhost:8123/apm" go test ./internal/storage/ -run TestTraceSummaryPopulates -v`
Expected: build failure `undefined: GetTraceSummary` (implemented in Task 2). This confirms the test is wired; DDL itself is exercised once Task 2 lands.

- [ ] **Step 5: Apply schema to running CH (so later steps see the tables)**

Run:
```bash
export PATH="/opt/homebrew/bin:$PATH"
docker compose -f deploy/docker-compose.yml exec -T clickhouse clickhouse-client --multiquery < schema/002_derived.sql
docker compose -f deploy/docker-compose.yml exec -T clickhouse clickhouse-client -q "EXISTS TABLE apm.trace_summary"
```
Expected: `1`

- [ ] **Step 6: Commit**

```bash
git add schema/002_derived.sql deploy/init/002_derived.sql internal/storage/derived_test.go
git commit -m "feat: derived MVs (trace_summary, red_rollup) schema

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 레코드 요약 조회 (trace_summary -Merge)

**Files:**
- Create: `internal/storage/derived.go`
- Test: `internal/storage/derived_test.go` (Task 1's TestTraceSummaryPopulates now passes)

**Interfaces:**
- Produces:
  - `type TraceSummaryRow struct { TraceID, EntryService, TransactionName string; RootHTTPStatus uint16; DurationMs float64; SpanCount, ErrorCount, SqlCount, HttpCallCount uint64; SqlTimeMs, HttpCallTimeMs float64; StartTime time.Time }`
  - `func (s *Store) GetTraceSummary(ctx context.Context, tenantID, traceID string) (TraceSummaryRow, error)`

- [ ] **Step 1: Implement GetTraceSummary**

`internal/storage/derived.go`:
```go
package storage

import (
	"context"
	"time"
)

type TraceSummaryRow struct {
	TraceID         string
	EntryService    string
	TransactionName string
	RootHTTPStatus  uint16
	StartTime       time.Time
	DurationMs      float64
	SpanCount       uint64
	ErrorCount      uint64
	SqlCount        uint64
	HttpCallCount   uint64
	SqlTimeMs       float64
	HttpCallTimeMs  float64
}

func (s *Store) GetTraceSummary(ctx context.Context, tenantID, traceID string) (TraceSummaryRow, error) {
	const q = `
SELECT
    anyIfMerge(entry_service),
    anyIfMerge(transaction_name),
    anyIfMerge(root_http_status),
    minMerge(start_ns)                                   AS start_ns,
    (maxMerge(end_ns) - minMerge(start_ns)) / 1e6        AS duration_ms,
    countMerge(span_count),
    sumMerge(error_count),
    sumMerge(sql_count),
    sumMerge(http_call_count),
    sumMerge(sql_time_ns) / 1e6                          AS sql_ms,
    sumMerge(http_call_time_ns) / 1e6                    AS http_ms
FROM apm.trace_summary
WHERE tenant_id = ? AND trace_id = ?
GROUP BY tenant_id, trace_id`
	var r TraceSummaryRow
	var startNs uint64
	row := s.db.QueryRowContext(ctx, q, tenantID, traceID)
	if err := row.Scan(&r.EntryService, &r.TransactionName, &r.RootHTTPStatus,
		&startNs, &r.DurationMs, &r.SpanCount, &r.ErrorCount, &r.SqlCount,
		&r.HttpCallCount, &r.SqlTimeMs, &r.HttpCallTimeMs); err != nil {
		return TraceSummaryRow{}, err
	}
	r.TraceID = traceID
	r.StartTime = time.Unix(0, int64(startNs)).UTC()
	return r, nil
}
```

- [ ] **Step 2: Run Task 1's test — expect PASS**

Run: `export PATH="/opt/homebrew/bin:$PATH"; APM_TEST_CH_DSN="clickhouse://localhost:8123/apm" go test ./internal/storage/ -run TestTraceSummaryPopulates -v`
Expected: PASS (entry SvcA, /p, span_count 3, sql 1, http 1, ~200ms, sql ~30ms).

- [ ] **Step 3: Commit**

```bash
git add internal/storage/derived.go
git commit -m "feat: GetTraceSummary reads trace_summary via -Merge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 서비스 RED 조회 (red_rollup -Merge)

**Files:**
- Modify: `internal/storage/derived.go`
- Test: `internal/storage/derived_test.go` (add RED test)

**Interfaces:**
- Produces:
  - `type REDPoint struct { Minute time.Time; RequestCount, ErrorCount uint64; P50Ms, P95Ms, P99Ms float64 }`
  - `func (s *Store) ListServices(ctx context.Context, tenantID string) ([]string, error)`
  - `func (s *Store) GetServiceRED(ctx context.Context, tenantID, service string, from, to time.Time) ([]REDPoint, error)`

- [ ] **Step 1: Write failing test**

Append to `internal/storage/derived_test.go`:
```go
func TestServiceRED(t *testing.T) {
	s := testStoreDerived(t)
	ctx := context.Background()
	now := time.Now().UTC()
	svc := "RedSvc" + now.Format("150405")
	spans := []otlp.Span{
		{TenantID: "default", TraceID: "rd1", SpanID: "s1", ServiceName: svc, SpanName: "GET /a",
			SpanKind: "SERVER", StartTime: now, DurationNs: 100_000_000, StatusCode: "OK",
			ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
		{TenantID: "default", TraceID: "rd2", SpanID: "s2", ServiceName: svc, SpanName: "GET /a",
			SpanKind: "SERVER", StartTime: now, DurationNs: 300_000_000, StatusCode: "ERROR",
			ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
	}
	if err := s.InsertSpans(ctx, spans); err != nil {
		t.Fatalf("insert: %v", err)
	}
	pts, err := s.GetServiceRED(ctx, "default", svc, now.Add(-2*time.Minute), now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("GetServiceRED: %v", err)
	}
	var reqs, errs uint64
	for _, p := range pts {
		reqs += p.RequestCount
		errs += p.ErrorCount
	}
	if reqs != 2 || errs != 1 {
		t.Fatalf("reqs=%d errs=%d (want 2,1)", reqs, errs)
	}
}
```

- [ ] **Step 2: Run — expect FAIL** (`undefined: GetServiceRED`)

Run: `export PATH="/opt/homebrew/bin:$PATH"; APM_TEST_CH_DSN="clickhouse://localhost:8123/apm" go test ./internal/storage/ -run TestServiceRED -v`
Expected: FAIL (undefined).

- [ ] **Step 3: Implement**

Append to `internal/storage/derived.go`:
```go
type REDPoint struct {
	Minute       time.Time
	RequestCount uint64
	ErrorCount   uint64
	P50Ms        float64
	P95Ms        float64
	P99Ms        float64
}

func (s *Store) ListServices(ctx context.Context, tenantID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT DISTINCT service_name FROM apm.red_rollup WHERE tenant_id = ? ORDER BY service_name`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (s *Store) GetServiceRED(ctx context.Context, tenantID, service string, from, to time.Time) ([]REDPoint, error) {
	const q = `
SELECT
    minute,
    countMerge(request_count),
    sumMerge(error_count),
    quantilesMerge(0.5, 0.95, 0.99)(duration_q) AS qs
FROM apm.red_rollup
WHERE tenant_id = ? AND service_name = ? AND minute >= ? AND minute <= ?
GROUP BY minute
ORDER BY minute`
	rows, err := s.db.QueryContext(ctx, q, tenantID, service, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []REDPoint
	for rows.Next() {
		var p REDPoint
		var qs []float64
		if err := rows.Scan(&p.Minute, &p.RequestCount, &p.ErrorCount, &qs); err != nil {
			return nil, err
		}
		if len(qs) == 3 {
			p.P50Ms, p.P95Ms, p.P99Ms = qs[0]/1e6, qs[1]/1e6, qs[2]/1e6
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
```
> Note: `quantilesMerge(...)(duration_q)` returns an `Array(Float64)`; clickhouse-go HTTP scans it into `[]float64`. If scanning fails, the fix is to scan into `[]float64` (already done) — do not change the SQL.

- [ ] **Step 4: Run — expect PASS**

Run: `export PATH="/opt/homebrew/bin:$PATH"; APM_TEST_CH_DSN="clickhouse://localhost:8123/apm" go test ./internal/storage/ -run TestServiceRED -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/storage/derived.go internal/storage/derived_test.go
git commit -m "feat: ListServices + GetServiceRED from red_rollup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Query API — record summary, services, RED

**Files:**
- Create: `query/derived_api.go`
- Test: `query/derived_api_test.go`
- Modify: `query/api.go` (register new routes on the same mux)

**Interfaces:**
- Consumes: `storage.GetTraceSummary`, `storage.ListServices`, `storage.GetServiceRED`.
- Produces (extend `Reader` interface): endpoints
  - `GET /api/v1/transactions/{traceID}/summary` → `TraceSummaryDTO`
  - `GET /api/v1/services` → `["SvcA", ...]`
  - `GET /api/v1/services/{name}/red?from=RFC3339&to=RFC3339` → `[]REDPointDTO`

- [ ] **Step 1: Extend Reader + add handlers (write failing test first)**

`query/derived_api_test.go`:
```go
package query

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type fakeDerived struct{ fakeReader }

func (fakeDerived) GetTraceSummary(_ context.Context, _, traceID string) (storage.TraceSummaryRow, error) {
	return storage.TraceSummaryRow{TraceID: traceID, EntryService: "SvcA", TransactionName: "/p",
		DurationMs: 200, SpanCount: 3, SqlCount: 1, HttpCallCount: 1, SqlTimeMs: 30, HttpCallTimeMs: 50}, nil
}
func (fakeDerived) ListServices(_ context.Context, _ string) ([]string, error) {
	return []string{"SvcA", "SvcB"}, nil
}
func (fakeDerived) GetServiceRED(_ context.Context, _, _ string, _, _ time.Time) ([]storage.REDPoint, error) {
	return []storage.REDPoint{{RequestCount: 2, ErrorCount: 1, P95Ms: 300}}, nil
}

func TestSummaryEndpoint(t *testing.T) {
	srv := httptest.NewServer(Router(fakeDerived{}))
	defer srv.Close()
	resp, _ := http.Get(srv.URL + "/api/v1/transactions/abc/summary")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var d TraceSummaryDTO
	json.NewDecoder(resp.Body).Decode(&d)
	if d.EntryService != "SvcA" || d.SqlCount != 1 || d.DurationMs != 200 {
		t.Fatalf("dto %+v", d)
	}
}

func TestServicesAndREDEndpoints(t *testing.T) {
	srv := httptest.NewServer(Router(fakeDerived{}))
	defer srv.Close()
	r1, _ := http.Get(srv.URL + "/api/v1/services")
	var svcs []string
	json.NewDecoder(r1.Body).Decode(&svcs)
	if len(svcs) != 2 || svcs[0] != "SvcA" {
		t.Fatalf("services %v", svcs)
	}
	r2, _ := http.Get(srv.URL + "/api/v1/services/SvcA/red?from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z")
	var pts []REDPointDTO
	json.NewDecoder(r2.Body).Decode(&pts)
	if len(pts) != 1 || pts[0].RequestCount != 2 {
		t.Fatalf("red %+v", pts)
	}
}
```

- [ ] **Step 2: Run — expect FAIL** (Reader lacks new methods; DTOs undefined)

Run: `export PATH="/opt/homebrew/bin:$PATH"; go test ./query/ -run 'TestSummaryEndpoint|TestServicesAndREDEndpoints' -v`
Expected: build failure.

- [ ] **Step 3: Extend Reader interface in `query/api.go`**

In `query/api.go`, add these methods to the `Reader` interface (keep existing ones):
```go
	GetTraceSummary(ctx context.Context, tenant, traceID string) (storage.TraceSummaryRow, error)
	ListServices(ctx context.Context, tenant string) ([]string, error)
	GetServiceRED(ctx context.Context, tenant, service string, from, to time.Time) ([]storage.REDPoint, error)
```
(Add `"time"` import to api.go if not present.)

- [ ] **Step 4: Implement handlers**

`query/derived_api.go`:
```go
package query

import (
	"net/http"
	"time"
)

type TraceSummaryDTO struct {
	TraceID         string  `json:"traceId"`
	EntryService    string  `json:"entryService"`
	TransactionName string  `json:"transactionName"`
	RootHTTPStatus  uint16  `json:"rootHttpStatus"`
	StartTime       string  `json:"startTime"`
	DurationMs      float64 `json:"durationMs"`
	SpanCount       uint64  `json:"spanCount"`
	ErrorCount      uint64  `json:"errorCount"`
	SqlCount        uint64  `json:"sqlCount"`
	HttpCallCount   uint64  `json:"httpCallCount"`
	SqlTimeMs       float64 `json:"sqlTimeMs"`
	HttpCallTimeMs  float64 `json:"httpCallTimeMs"`
}

type REDPointDTO struct {
	Minute       string  `json:"minute"`
	RequestCount uint64  `json:"requestCount"`
	ErrorCount   uint64  `json:"errorCount"`
	P50Ms        float64 `json:"p50Ms"`
	P95Ms        float64 `json:"p95Ms"`
	P99Ms        float64 `json:"p99Ms"`
}

func registerDerived(mux *http.ServeMux, r Reader) {
	mux.HandleFunc("GET /api/v1/transactions/{traceID}/summary", func(w http.ResponseWriter, req *http.Request) {
		s, err := r.GetTraceSummary(req.Context(), defaultTenant, req.PathValue("traceID"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, TraceSummaryDTO{
			TraceID: s.TraceID, EntryService: s.EntryService, TransactionName: s.TransactionName,
			RootHTTPStatus: s.RootHTTPStatus, StartTime: s.StartTime.Format("2006-01-02T15:04:05.000Z"),
			DurationMs: s.DurationMs, SpanCount: s.SpanCount, ErrorCount: s.ErrorCount,
			SqlCount: s.SqlCount, HttpCallCount: s.HttpCallCount,
			SqlTimeMs: s.SqlTimeMs, HttpCallTimeMs: s.HttpCallTimeMs,
		})
	})
	mux.HandleFunc("GET /api/v1/services", func(w http.ResponseWriter, req *http.Request) {
		svcs, err := r.ListServices(req.Context(), defaultTenant)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if svcs == nil {
			svcs = []string{}
		}
		writeJSON(w, svcs)
	})
	mux.HandleFunc("GET /api/v1/services/{name}/red", func(w http.ResponseWriter, req *http.Request) {
		from, _ := time.Parse(time.RFC3339, req.URL.Query().Get("from"))
		to, _ := time.Parse(time.RFC3339, req.URL.Query().Get("to"))
		if to.IsZero() {
			to = time.Now().UTC()
		}
		if from.IsZero() {
			from = to.Add(-1 * time.Hour)
		}
		pts, err := r.GetServiceRED(req.Context(), defaultTenant, req.PathValue("name"), from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]REDPointDTO, 0, len(pts))
		for _, p := range pts {
			out = append(out, REDPointDTO{
				Minute: p.Minute.Format(time.RFC3339), RequestCount: p.RequestCount, ErrorCount: p.ErrorCount,
				P50Ms: p.P50Ms, P95Ms: p.P95Ms, P99Ms: p.P99Ms,
			})
		}
		writeJSON(w, out)
	})
}
```

- [ ] **Step 5: Call registerDerived from Router**

In `query/api.go` `Router`, before `return withCORS(mux)`, add: `registerDerived(mux, r)`.

- [ ] **Step 6: Run — expect PASS**

Run: `export PATH="/opt/homebrew/bin:$PATH"; go test ./query/ -v`
Expected: all query tests PASS (existing + new).

- [ ] **Step 7: Commit**

```bash
git add query/derived_api.go query/derived_api_test.go query/api.go
git commit -m "feat: query API for record summary, services, RED

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: UI — 레코드 요약 패널 + RED 대시보드

**Files:**
- Modify: `web/src/api.ts` (add types + fetchers)
- Create: `web/src/RecordSummary.tsx`
- Create: `web/src/RedDashboard.tsx`
- Modify: `web/src/App.tsx` (tab nav: 트레이스 분석 / RED 대시보드; show RecordSummary in detail pane)
- Add dep: `echarts` + `echarts-for-react`

**Interfaces:**
- Consumes: `/api/v1/transactions/{id}/summary`, `/api/v1/services`, `/api/v1/services/{name}/red`.

- [ ] **Step 1: Add ECharts dep**

Run: `cd web && npm install echarts echarts-for-react`

- [ ] **Step 2: Extend api.ts**

Append to `web/src/api.ts`:
```ts
export type TraceSummary = {
  traceId: string; entryService: string; transactionName: string; rootHttpStatus: number;
  startTime: string; durationMs: number; spanCount: number; errorCount: number;
  sqlCount: number; httpCallCount: number; sqlTimeMs: number; httpCallTimeMs: number;
};
export type REDPoint = {
  minute: string; requestCount: number; errorCount: number;
  p50Ms: number; p95Ms: number; p99Ms: number;
};
export async function fetchSummary(traceId: string): Promise<TraceSummary> {
  const r = await fetch(`${BASE}/api/v1/transactions/${traceId}/summary`);
  if (!r.ok) throw new Error(`summary ${r.status}`);
  return r.json();
}
export async function fetchServices(): Promise<string[]> {
  const r = await fetch(`${BASE}/api/v1/services`);
  if (!r.ok) throw new Error(`services ${r.status}`);
  return r.json();
}
export async function fetchRED(service: string, fromISO: string, toISO: string): Promise<REDPoint[]> {
  const r = await fetch(`${BASE}/api/v1/services/${service}/red?from=${fromISO}&to=${toISO}`);
  if (!r.ok) throw new Error(`red ${r.status}`);
  return r.json();
}
```

- [ ] **Step 3: RecordSummary component**

`web/src/RecordSummary.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import { fetchSummary } from "./api";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 12 }}>
      <span style={{ color: "#888" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function RecordSummary({ traceId }: { traceId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["summary", traceId], queryFn: () => fetchSummary(traceId) });
  if (isLoading || !data) return <div>로딩…</div>;
  return (
    <div style={{ maxWidth: 420 }}>
      <Field label="트랜잭션" value={data.transactionName || "-"} />
      <Field label="에이전트 명" value={data.entryService} />
      <Field label="경과 시간" value={`${data.durationMs.toFixed(2)} ms`} />
      <Field label="스팬 수" value={data.spanCount} />
      <Field label="에러 수" value={data.errorCount} />
      <Field label="SQL 시간 / 건수" value={`${data.sqlTimeMs.toFixed(2)} ms / ${data.sqlCount}`} />
      <Field label="HTTP 호출 시간 / 건수" value={`${data.httpCallTimeMs.toFixed(2)} ms / ${data.httpCallCount}`} />
      <Field label="HTTP 상태" value={data.rootHttpStatus || "-"} />
    </div>
  );
}
```

- [ ] **Step 4: RedDashboard component**

`web/src/RedDashboard.tsx`:
```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { fetchServices, fetchRED } from "./api";

export function RedDashboard() {
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices, refetchInterval: 10000 });
  const [svc, setSvc] = useState<string>("");
  const service = svc || (services && services[0]) || "";
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: red } = useQuery({
    queryKey: ["red", service, from],
    queryFn: () => fetchRED(service, from, to),
    enabled: !!service,
    refetchInterval: 10000,
  });
  const pts = red ?? [];
  const x = pts.map((p) => p.minute.slice(11, 16));
  const option = {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis" },
    legend: { textStyle: { color: "#ccc" } },
    grid: { left: 48, right: 16, top: 30, bottom: 30 },
    xAxis: { type: "category", data: x, axisLabel: { color: "#999" } },
    yAxis: { type: "value", axisLabel: { color: "#999" } },
    series: [
      { name: "Requests", type: "bar", data: pts.map((p) => p.requestCount) },
      { name: "Errors", type: "bar", data: pts.map((p) => p.errorCount) },
      { name: "p95 ms", type: "line", yAxisIndex: 0, data: pts.map((p) => Math.round(p.p95Ms)) },
    ],
  };
  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8 }}>
        서비스:{" "}
        <select value={service} onChange={(e) => setSvc(e.target.value)}>
          {(services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <ReactECharts option={option} style={{ height: 360 }} theme="dark" />
    </div>
  );
}
```

- [ ] **Step 5: Wire into App.tsx (tab nav + record summary in detail)**

Modify `web/src/App.tsx` to add a simple top nav switching between "트레이스 분석" (existing split) and "RED 대시보드" (`<RedDashboard/>`), and in the trace-analysis right pane show `<RecordSummary traceId={sel.traceId}/>` above `<TraceTree>`. Keep the existing QueryClientProvider and dark theme. Minimal example:
```tsx
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TransactionTable } from "./TransactionTable";
import { TraceTree } from "./TraceTree";
import { RecordSummary } from "./RecordSummary";
import { RedDashboard } from "./RedDashboard";
import { Transaction } from "./api";

const qc = new QueryClient();

export default function App() {
  const [sel, setSel] = useState<Transaction | null>(null);
  const [tab, setTab] = useState<"trace" | "red">("trace");
  return (
    <QueryClientProvider client={qc}>
      <div style={{ height: "100vh", background: "#111", color: "#ddd", display: "flex", flexDirection: "column" }}>
        <nav style={{ display: "flex", gap: 16, padding: "8px 12px", borderBottom: "1px solid #333" }}>
          <a onClick={() => setTab("trace")} style={{ cursor: "pointer", color: tab === "trace" ? "#fff" : "#888" }}>트레이스 분석</a>
          <a onClick={() => setTab("red")} style={{ cursor: "pointer", color: tab === "red" ? "#fff" : "#888" }}>RED 대시보드</a>
        </nav>
        {tab === "red" ? (
          <RedDashboard />
        ) : (
          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
            <div style={{ flex: 1, overflow: "auto", padding: 12, borderRight: "1px solid #333" }}>
              <TransactionTable onSelect={setSel} />
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
              {sel ? (
                <>
                  <h4>레코드 요약</h4>
                  <RecordSummary traceId={sel.traceId} />
                  <h4 style={{ marginTop: 16 }}>트리 뷰</h4>
                  <TraceTree traceId={sel.traceId} />
                </>
              ) : <div>트랜잭션을 선택하세요</div>}
            </div>
          </div>
        )}
      </div>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 6: Build**

Run: `cd web && npm run build`
Expected: 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add web/src web/package.json web/package-lock.json
git commit -m "feat: UI record summary panel + RED dashboard (ECharts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** trace_summary MV (T1) + record summary read (T2) + RED rollup read (T3) + query API (T4) + UI (T5). Covers Phase-2A scope (derived MVs + 레코드요약 + RED 대시보드). Service map + real-time X-View are Phase 2B (separate plan).

**Placeholders:** none — DDL is prototype-verified; Go/TS code is concrete.

**Type consistency:** `TraceSummaryRow`/`REDPoint` (storage) → `Reader` methods (query) → `TraceSummaryDTO`/`REDPointDTO` (JSON) → `TraceSummary`/`REDPoint` (web) align on field names and float/uint units. `durationMs`/`*Ms` are float64/number consistent with Phase 1.

**Deferred/known nuances:**
- trace_summary uses `parent_span_id=''` as the root-span selector; some OTel traces have a non-HTTP root (e.g. connection span) → transaction_name may be empty for those. Acceptable for 2A; refine root selection in 2B if needed.
- MV backfill of pre-existing spans is NOT done (MVs only fire on new inserts). Tests insert fresh spans; the running demo generates new traffic. A historical backfill script is out of scope.

## 이후: Phase 2B (별도 계획)
서비스맵(spans 셀프조인 by parent_span_id) + 실시간 X-View(WebSocket 최근 trace_summary 스트림 + ECharts 히트맵/스캐터).
