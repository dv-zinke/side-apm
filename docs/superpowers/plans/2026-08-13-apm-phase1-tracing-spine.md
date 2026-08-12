# APM Phase 1 — 트레이싱 등뼈(관통) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Java 데모앱을 표준 OTel javaagent로 계측 → 자체 Go 게이트웨이 → DirectBuffer → Go writer → ClickHouse `spans` → Go 쿼리 API → React UI에서 트랜잭션 리스트와 트리뷰까지 실제로 관통시킨다.

**Architecture:** OTLP/HTTP를 수신하는 Go 게이트웨이가 스팬을 내부 `Span` 모델로 매핑하고 `BufferPort`(Phase 1은 DirectBuffer=인라인)로 넘겨 ClickHouse `spans` 테이블에 배치 삽입한다. Go 쿼리 서비스가 같은 테이블을 읽어 REST로 제공하고, React UI가 트랜잭션 리스트와 트레이스 트리를 그린다. 단일 테넌트(`default`) 하드코딩, Kafka·파생 MV·인증·enrichment는 이후 Phase.

**Tech Stack:** Go 1.22+ (net/http, `github.com/ClickHouse/clickhouse-go/v2`, `go.opentelemetry.io/proto/otlp`), ClickHouse 24.x, React 18 + TypeScript + Vite + TanStack Query, Java 17 + Spring Boot 3 데모, docker-compose.

## Global Constraints

- Go module path: `github.com/heejune/apm` (모든 import 경로 이 접두사).
- Go 버전 하한: **1.22**. ClickHouse 이미지: **`clickhouse/clickhouse-server:24.8`**.
- 단일 테넌트: 모든 스팬 `tenant_id = "default"` (Phase 4에서 실제 멀티테넌시).
- 시간은 UTC `time.Time`, ClickHouse `DateTime64(9)`.
- trace_id/span_id는 **소문자 hex 문자열**로 저장(OTLP는 bytes → hex 인코딩).
- span_kind 문자열 집합: `SERVER|CLIENT|INTERNAL|PRODUCER|CONSUMER`.
- status_code 문자열 집합: `UNSET|OK|ERROR`.
- 통합테스트는 환경변수 `APM_TEST_CH_DSN`가 있을 때만 실행(없으면 `t.Skip`). 로컬은 docker-compose ClickHouse로 제공.
- 커밋 메시지 끝에: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

```
go.mod                                  -- module github.com/heejune/apm
schema/001_spans.sql                    -- ClickHouse spans DDL
internal/otlp/span.go                   -- Span 모델 + OTLP→Span 매핑
internal/otlp/span_test.go
internal/storage/clickhouse.go          -- CH 연결 + InsertSpans/ListTransactions/GetTraceSpans
internal/storage/clickhouse_test.go
internal/buffer/buffer.go               -- BufferPort 인터페이스 + DirectBuffer
internal/buffer/buffer_test.go
cmd/gateway/main.go                     -- OTLP/HTTP 게이트웨이 부팅
gateway/handler.go                      -- TracesHandler
gateway/handler_test.go
cmd/query/main.go                       -- 쿼리 서비스 부팅
query/api.go                            -- REST 핸들러(list, trace spans)
query/api_test.go
web/ (Vite React 앱)                     -- 트랜잭션 리스트 + 트리뷰
demo/java/ (Spring Boot)                -- 데모앱
deploy/docker-compose.yml               -- clickhouse + gateway + query + web
deploy/README.md                        -- 원커맨드 실행법
```

### 핵심 타입 (여러 태스크가 공유 — 여기서 한 번 정의)

```go
// internal/otlp/span.go
package otlp

import "time"

type Span struct {
	TenantID        string
	TraceID         string
	SpanID          string
	ParentSpanID    string
	ServiceName     string
	ServiceInstance string
	SpanName        string
	SpanKind        string // SERVER|CLIENT|INTERNAL|PRODUCER|CONSUMER
	StartTime       time.Time
	DurationNs      uint64
	StatusCode      string // UNSET|OK|ERROR
	HTTPMethod      string
	HTTPRoute       string
	HTTPURL         string
	HTTPStatusCode  uint16
	DBSystem        string
	DBStatement     string
	DBName          string
	ResourceAttrs   map[string]string
	SpanAttrs       map[string]string
}
```

---

### Task 1: ClickHouse 스키마 + 로컬 인프라

**Files:**
- Create: `deploy/docker-compose.yml` (ClickHouse 서비스만 우선)
- Create: `schema/001_spans.sql`
- Create: `go.mod`

**Interfaces:**
- Consumes: 없음
- Produces: `spans` 테이블(Phase 전체가 이 스키마에 의존), 로컬 CH DSN `clickhouse://localhost:9000/apm`

- [ ] **Step 1: Go 모듈 초기화**

Run:
```bash
cd /Users/heejune/Desktop/projects/side/apm
go mod init github.com/heejune/apm
```

- [ ] **Step 2: docker-compose에 ClickHouse 정의**

`deploy/docker-compose.yml`:
```yaml
services:
  clickhouse:
    image: clickhouse/clickhouse-server:24.8
    ports:
      - "9000:9000"   # native protocol
      - "8123:8123"   # http
    environment:
      CLICKHOUSE_DB: apm
    ulimits:
      nofile: { soft: 262144, hard: 262144 }
    volumes:
      - ./init:/docker-entrypoint-initdb.d
```

- [ ] **Step 3: 스키마 DDL 작성**

`schema/001_spans.sql`:
```sql
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
```

- [ ] **Step 4: init 디렉토리에 스키마 링크(자동 적용)**

Run:
```bash
mkdir -p deploy/init && cp schema/001_spans.sql deploy/init/001_spans.sql
```

- [ ] **Step 5: 기동 후 테이블 확인**

Run:
```bash
docker compose -f deploy/docker-compose.yml up -d clickhouse
sleep 8
docker compose -f deploy/docker-compose.yml exec clickhouse clickhouse-client -q "EXISTS TABLE apm.spans"
```
Expected: `1`

- [ ] **Step 6: Commit**

```bash
git add go.mod deploy/docker-compose.yml deploy/init schema/001_spans.sql
git commit -m "feat: ClickHouse spans schema + local compose

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: OTLP → Span 매핑 (`internal/otlp`)

**Files:**
- Create: `internal/otlp/span.go`
- Test: `internal/otlp/span_test.go`

**Interfaces:**
- Consumes: OTLP protobuf `*coltracepb.ExportTraceServiceRequest` (`go.opentelemetry.io/proto/otlp/collector/trace/v1`)
- Produces: `func MapTraces(req *coltracepb.ExportTraceServiceRequest, tenantID string) []Span`

- [ ] **Step 1: OTLP proto 의존성 추가**

Run:
```bash
go get go.opentelemetry.io/proto/otlp@v1.3.1
```

- [ ] **Step 2: 실패하는 테스트 작성**

`internal/otlp/span_test.go`:
```go
package otlp

import (
	"testing"
	"time"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

func strAttr(k, v string) *commonpb.KeyValue {
	return &commonpb.KeyValue{Key: k, Value: &commonpb.AnyValue{
		Value: &commonpb.AnyValue_StringValue{StringValue: v}}}
}

func TestMapTraces_ServerSpanWithHTTP(t *testing.T) {
	start := time.Date(2026, 8, 13, 6, 42, 56, 843000000, time.UTC)
	req := &coltracepb.ExportTraceServiceRequest{
		ResourceSpans: []*tracepb.ResourceSpans{{
			Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{
				strAttr("service.name", "GatewayService"),
			}},
			ScopeSpans: []*tracepb.ScopeSpans{{
				Spans: []*tracepb.Span{{
					TraceId:           []byte{0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0x9, 0xa, 0xb, 0xc, 0xd, 0xe, 0xf, 0x10},
					SpanId:            []byte{0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8},
					Name:              "GET /buy-request",
					Kind:              tracepb.Span_SPAN_KIND_SERVER,
					StartTimeUnixNano: uint64(start.UnixNano()),
					EndTimeUnixNano:   uint64(start.Add(1424 * time.Millisecond).UnixNano()),
					Status:            &tracepb.Status{Code: tracepb.Status_STATUS_CODE_OK},
					Attributes: []*commonpb.KeyValue{
						strAttr("http.request.method", "GET"),
						strAttr("http.route", "/buy-request"),
					},
				}},
			}},
		}},
	}

	got := MapTraces(req, "default")
	if len(got) != 1 {
		t.Fatalf("want 1 span, got %d", len(got))
	}
	s := got[0]
	if s.TenantID != "default" {
		t.Errorf("tenant: %q", s.TenantID)
	}
	if s.TraceID != "0102030405060708090a0b0c0d0e0f10" {
		t.Errorf("trace_id: %q", s.TraceID)
	}
	if s.ServiceName != "GatewayService" {
		t.Errorf("service: %q", s.ServiceName)
	}
	if s.SpanKind != "SERVER" {
		t.Errorf("kind: %q", s.SpanKind)
	}
	if s.DurationNs != uint64(1424*time.Millisecond) {
		t.Errorf("duration: %d", s.DurationNs)
	}
	if s.StatusCode != "OK" {
		t.Errorf("status: %q", s.StatusCode)
	}
	if s.HTTPMethod != "GET" || s.HTTPRoute != "/buy-request" {
		t.Errorf("http: %q %q", s.HTTPMethod, s.HTTPRoute)
	}
}
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `go test ./internal/otlp/ -run TestMapTraces_ServerSpanWithHTTP -v`
Expected: FAIL — `undefined: MapTraces`

- [ ] **Step 4: 매핑 구현**

`internal/otlp/span.go` (위 "핵심 타입"의 `Span` 정의 아래에 추가):
```go
import (
	"encoding/hex"
	"time"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

func kindString(k tracepb.Span_SpanKind) string {
	switch k {
	case tracepb.Span_SPAN_KIND_SERVER:
		return "SERVER"
	case tracepb.Span_SPAN_KIND_CLIENT:
		return "CLIENT"
	case tracepb.Span_SPAN_KIND_PRODUCER:
		return "PRODUCER"
	case tracepb.Span_SPAN_KIND_CONSUMER:
		return "CONSUMER"
	case tracepb.Span_SPAN_KIND_INTERNAL:
		return "INTERNAL"
	default:
		return "UNSPECIFIED"
	}
}

func statusString(s *tracepb.Status) string {
	if s == nil {
		return "UNSET"
	}
	switch s.Code {
	case tracepb.Status_STATUS_CODE_OK:
		return "OK"
	case tracepb.Status_STATUS_CODE_ERROR:
		return "ERROR"
	default:
		return "UNSET"
	}
}

func attrString(kv *commonpb.KeyValue) string {
	if kv == nil || kv.Value == nil {
		return ""
	}
	if v, ok := kv.Value.Value.(*commonpb.AnyValue_StringValue); ok {
		return v.StringValue
	}
	return ""
}

func attrMap(kvs []*commonpb.KeyValue) map[string]string {
	m := make(map[string]string, len(kvs))
	for _, kv := range kvs {
		m[kv.Key] = attrString(kv)
	}
	return m
}

func MapTraces(req *coltracepb.ExportTraceServiceRequest, tenantID string) []Span {
	var out []Span
	for _, rs := range req.GetResourceSpans() {
		res := attrMap(rs.GetResource().GetAttributes())
		for _, ss := range rs.GetScopeSpans() {
			for _, sp := range ss.GetSpans() {
				a := attrMap(sp.GetAttributes())
				httpStatus := uint16(0)
				if v := a["http.response.status_code"]; v != "" {
					if n, err := parseUint16(v); err == nil {
						httpStatus = n
					}
				}
				out = append(out, Span{
					TenantID:        tenantID,
					TraceID:         hex.EncodeToString(sp.GetTraceId()),
					SpanID:          hex.EncodeToString(sp.GetSpanId()),
					ParentSpanID:    hex.EncodeToString(sp.GetParentSpanId()),
					ServiceName:     res["service.name"],
					ServiceInstance: res["service.instance.id"],
					SpanName:        sp.GetName(),
					SpanKind:        kindString(sp.GetKind()),
					StartTime:       time.Unix(0, int64(sp.GetStartTimeUnixNano())).UTC(),
					DurationNs:      sp.GetEndTimeUnixNano() - sp.GetStartTimeUnixNano(),
					StatusCode:      statusString(sp.GetStatus()),
					HTTPMethod:      a["http.request.method"],
					HTTPRoute:       a["http.route"],
					HTTPURL:         a["url.full"],
					HTTPStatusCode:  httpStatus,
					DBSystem:        a["db.system"],
					DBStatement:     a["db.query.text"],
					DBName:          a["db.namespace"],
					ResourceAttrs:   res,
					SpanAttrs:       a,
				})
			}
		}
	}
	return out
}

func parseUint16(s string) (uint16, error) {
	var n uint16
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errNotNumber
		}
		n = n*10 + uint16(c-'0')
	}
	return n, nil
}

var errNotNumber = &mapError{"not a number"}

type mapError struct{ msg string }

func (e *mapError) Error() string { return e.msg }
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `go test ./internal/otlp/ -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/otlp go.mod go.sum
git commit -m "feat: OTLP traces to internal Span mapping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: ClickHouse 저장/조회 (`internal/storage`)

**Files:**
- Create: `internal/storage/clickhouse.go`
- Test: `internal/storage/clickhouse_test.go`

**Interfaces:**
- Consumes: `otlp.Span`
- Produces:
  - `func New(dsn string) (*Store, error)`
  - `func (s *Store) InsertSpans(ctx context.Context, spans []otlp.Span) error`
  - `type Filter struct { Service string; Limit int }`
  - `type TransactionRow struct { TraceID, ServiceName, TransactionName, StatusCode string; StartTime time.Time; DurationNs uint64 }`
  - `func (s *Store) ListTransactions(ctx context.Context, tenantID string, f Filter) ([]TransactionRow, error)`
  - `func (s *Store) GetTraceSpans(ctx context.Context, tenantID, traceID string) ([]otlp.Span, error)`

- [ ] **Step 1: 의존성 추가**

Run: `go get github.com/ClickHouse/clickhouse-go/v2@v2.30.0`

- [ ] **Step 2: 실패하는 통합 테스트 작성**

`internal/storage/clickhouse_test.go`:
```go
package storage

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/heejune/apm/internal/otlp"
)

func testStore(t *testing.T) *Store {
	dsn := os.Getenv("APM_TEST_CH_DSN")
	if dsn == "" {
		t.Skip("set APM_TEST_CH_DSN to run (e.g. clickhouse://localhost:9000/apm)")
	}
	s, err := New(dsn)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func TestInsertAndQuery(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, _ = s.conn.Exec, ctx // ensure fields visible
	now := time.Now().UTC().Truncate(time.Second)
	spans := []otlp.Span{
		{TenantID: "default", TraceID: "aa11", SpanID: "01", ServiceName: "GatewayService",
			SpanName: "GET /x", SpanKind: "SERVER", StartTime: now, DurationNs: 1424000000,
			StatusCode: "OK", HTTPRoute: "/x", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
		{TenantID: "default", TraceID: "aa11", SpanID: "02", ParentSpanID: "01", ServiceName: "GatewayService",
			SpanName: "SELECT", SpanKind: "CLIENT", StartTime: now, DurationNs: 100000,
			StatusCode: "OK", DBSystem: "postgresql", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
	}
	if err := s.InsertSpans(ctx, spans); err != nil {
		t.Fatalf("InsertSpans: %v", err)
	}

	txns, err := s.ListTransactions(ctx, "default", Filter{Limit: 10})
	if err != nil {
		t.Fatalf("ListTransactions: %v", err)
	}
	found := false
	for _, r := range txns {
		if r.TraceID == "aa11" && r.ServiceName == "GatewayService" {
			found = true
		}
	}
	if !found {
		t.Fatalf("transaction aa11 not in %+v", txns)
	}

	got, err := s.GetTraceSpans(ctx, "default", "aa11")
	if err != nil {
		t.Fatalf("GetTraceSpans: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 spans, got %d", len(got))
	}
}
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `go test ./internal/storage/ -v`
Expected: FAIL — `undefined: New` (또는 DSN 미설정 시 SKIP)

- [ ] **Step 4: 저장/조회 구현**

`internal/storage/clickhouse.go`:
```go
package storage

import (
	"context"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/heejune/apm/internal/otlp"
)

type Store struct{ conn driver.Conn }

func New(dsn string) (*Store, error) {
	opts, err := clickhouse.ParseDSN(dsn)
	if err != nil {
		return nil, err
	}
	conn, err := clickhouse.Open(opts)
	if err != nil {
		return nil, err
	}
	return &Store{conn: conn}, nil
}

func (s *Store) InsertSpans(ctx context.Context, spans []otlp.Span) error {
	if len(spans) == 0 {
		return nil
	}
	batch, err := s.conn.PrepareBatch(ctx, `INSERT INTO apm.spans`)
	if err != nil {
		return err
	}
	for _, sp := range spans {
		if err := batch.Append(
			sp.TenantID, sp.TraceID, sp.SpanID, sp.ParentSpanID,
			sp.ServiceName, sp.ServiceInstance, sp.SpanName, sp.SpanKind,
			sp.StartTime, sp.DurationNs, sp.StatusCode,
			sp.HTTPMethod, sp.HTTPRoute, sp.HTTPURL, sp.HTTPStatusCode,
			sp.DBSystem, sp.DBStatement, sp.DBName,
			sp.ResourceAttrs, sp.SpanAttrs,
		); err != nil {
			return err
		}
	}
	return batch.Send()
}

type Filter struct {
	Service string
	Limit   int
}

type TransactionRow struct {
	TraceID         string
	ServiceName     string
	TransactionName string
	StatusCode      string
	StartTime       time.Time
	DurationNs      uint64
}

// Phase 1: trace_summary MV가 없으므로 SERVER 스팬을 트랜잭션으로 간주.
func (s *Store) ListTransactions(ctx context.Context, tenantID string, f Filter) ([]TransactionRow, error) {
	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 100
	}
	q := `
SELECT trace_id, service_name, span_name, status_code, start_time, duration_ns
FROM apm.spans
WHERE tenant_id = ? AND span_kind = 'SERVER'
  AND (? = '' OR service_name = ?)
ORDER BY start_time DESC
LIMIT ?`
	rows, err := s.conn.Query(ctx, q, tenantID, f.Service, f.Service, f.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TransactionRow
	for rows.Next() {
		var r TransactionRow
		if err := rows.Scan(&r.TraceID, &r.ServiceName, &r.TransactionName,
			&r.StatusCode, &r.StartTime, &r.DurationNs); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) GetTraceSpans(ctx context.Context, tenantID, traceID string) ([]otlp.Span, error) {
	q := `
SELECT trace_id, span_id, parent_span_id, service_name, service_instance,
       span_name, span_kind, start_time, duration_ns, status_code,
       http_method, http_route, http_url, http_status_code,
       db_system, db_statement, db_name
FROM apm.spans
WHERE tenant_id = ? AND trace_id = ?
ORDER BY start_time ASC
LIMIT 1 BY span_id`
	rows, err := s.conn.Query(ctx, q, tenantID, traceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []otlp.Span
	for rows.Next() {
		var sp otlp.Span
		sp.TenantID = tenantID
		if err := rows.Scan(&sp.TraceID, &sp.SpanID, &sp.ParentSpanID, &sp.ServiceName,
			&sp.ServiceInstance, &sp.SpanName, &sp.SpanKind, &sp.StartTime, &sp.DurationNs,
			&sp.StatusCode, &sp.HTTPMethod, &sp.HTTPRoute, &sp.HTTPURL, &sp.HTTPStatusCode,
			&sp.DBSystem, &sp.DBStatement, &sp.DBName); err != nil {
			return nil, err
		}
		out = append(out, sp)
	}
	return out, rows.Err()
}
```

- [ ] **Step 5: ClickHouse 띄우고 테스트 통과 확인**

Run:
```bash
docker compose -f deploy/docker-compose.yml up -d clickhouse && sleep 8
APM_TEST_CH_DSN="clickhouse://localhost:9000/apm" go test ./internal/storage/ -v
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/storage go.mod go.sum
git commit -m "feat: ClickHouse span insert + transaction/trace queries

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: BufferPort + DirectBuffer (`internal/buffer`)

**Files:**
- Create: `internal/buffer/buffer.go`
- Test: `internal/buffer/buffer_test.go`

**Interfaces:**
- Consumes: `otlp.Span`
- Produces:
  - `type Port interface { Publish(ctx context.Context, spans []otlp.Span) error }`
  - `type Inserter interface { InsertSpans(ctx context.Context, spans []otlp.Span) error }` (`*storage.Store`가 만족)
  - `type Direct struct { Store Inserter }` with `Publish`

- [ ] **Step 1: 실패하는 테스트 작성**

`internal/buffer/buffer_test.go`:
```go
package buffer

import (
	"context"
	"testing"

	"github.com/heejune/apm/internal/otlp"
)

type fakeInserter struct{ got []otlp.Span }

func (f *fakeInserter) InsertSpans(_ context.Context, spans []otlp.Span) error {
	f.got = append(f.got, spans...)
	return nil
}

func TestDirectPublish(t *testing.T) {
	fi := &fakeInserter{}
	var p Port = &Direct{Store: fi}
	err := p.Publish(context.Background(), []otlp.Span{{TraceID: "aa"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(fi.got) != 1 || fi.got[0].TraceID != "aa" {
		t.Fatalf("insert not called correctly: %+v", fi.got)
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `go test ./internal/buffer/ -v`
Expected: FAIL — `undefined: Port`

- [ ] **Step 3: 구현**

`internal/buffer/buffer.go`:
```go
package buffer

import (
	"context"

	"github.com/heejune/apm/internal/otlp"
)

type Port interface {
	Publish(ctx context.Context, spans []otlp.Span) error
}

type Inserter interface {
	InsertSpans(ctx context.Context, spans []otlp.Span) error
}

// Direct: Phase 1 — Kafka 없이 Writer(=Store) 인라인 호출.
type Direct struct{ Store Inserter }

func (d *Direct) Publish(ctx context.Context, spans []otlp.Span) error {
	return d.Store.InsertSpans(ctx, spans)
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `go test ./internal/buffer/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/buffer
git commit -m "feat: BufferPort interface + DirectBuffer (inline writer)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: OTLP/HTTP 게이트웨이 (`gateway` + `cmd/gateway`)

**Files:**
- Create: `gateway/handler.go`
- Test: `gateway/handler_test.go`
- Create: `cmd/gateway/main.go`

**Interfaces:**
- Consumes: `buffer.Port`, `otlp.MapTraces`
- Produces: `func TracesHandler(buf buffer.Port) http.HandlerFunc` — `POST /v1/traces` (Content-Type `application/x-protobuf`)

- [ ] **Step 1: protobuf 언마샬 의존성 확인**

Run: `go get google.golang.org/protobuf@v1.34.2`

- [ ] **Step 2: 실패하는 테스트 작성**

`gateway/handler_test.go`:
```go
package gateway

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"google.golang.org/protobuf/proto"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"

	"github.com/heejune/apm/internal/otlp"
)

type capBuf struct{ got []otlp.Span }

func (c *capBuf) Publish(_ context.Context, spans []otlp.Span) error {
	c.got = append(c.got, spans...)
	return nil
}

func TestTracesHandler_Accepts(t *testing.T) {
	req := &coltracepb.ExportTraceServiceRequest{
		ResourceSpans: []*tracepb.ResourceSpans{{
			Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{{
				Key: "service.name", Value: &commonpb.AnyValue{
					Value: &commonpb.AnyValue_StringValue{StringValue: "Svc"}}}}},
			ScopeSpans: []*tracepb.ScopeSpans{{Spans: []*tracepb.Span{{
				TraceId: []byte("0123456789abcdef"), SpanId: []byte("01234567"),
				Name: "op", Kind: tracepb.Span_SPAN_KIND_SERVER,
			}}}},
		}},
	}
	body, _ := proto.Marshal(req)

	cb := &capBuf{}
	h := TracesHandler(cb)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/traces", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/x-protobuf")
	h(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if len(cb.got) != 1 || cb.got[0].ServiceName != "Svc" {
		t.Fatalf("published = %+v", cb.got)
	}
}
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `go test ./gateway/ -v`
Expected: FAIL — `undefined: TracesHandler`

- [ ] **Step 4: 핸들러 구현**

`gateway/handler.go`:
```go
package gateway

import (
	"io"
	"net/http"

	"google.golang.org/protobuf/proto"

	coltracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"

	"github.com/heejune/apm/internal/buffer"
	"github.com/heejune/apm/internal/otlp"
)

const defaultTenant = "default" // Phase 4에서 API key 기반으로 대체

func TracesHandler(buf buffer.Port) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20)) // 16MB 상한
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}
		var req coltracepb.ExportTraceServiceRequest
		if err := proto.Unmarshal(body, &req); err != nil {
			http.Error(w, "invalid protobuf", http.StatusBadRequest)
			return
		}
		spans := otlp.MapTraces(&req, defaultTenant)
		if err := buf.Publish(r.Context(), spans); err != nil {
			http.Error(w, "publish failed", http.StatusServiceUnavailable)
			return
		}
		// OTLP 성공 응답: 빈 ExportTraceServiceResponse
		resp, _ := proto.Marshal(&coltracepb.ExportTraceServiceResponse{})
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(resp)
	}
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `go test ./gateway/ -v`
Expected: PASS

- [ ] **Step 6: main 작성**

`cmd/gateway/main.go`:
```go
package main

import (
	"log"
	"net/http"
	"os"

	"github.com/heejune/apm/gateway"
	"github.com/heejune/apm/internal/buffer"
	"github.com/heejune/apm/internal/storage"
)

func main() {
	dsn := getenv("APM_CH_DSN", "clickhouse://localhost:9000/apm")
	store, err := storage.New(dsn)
	if err != nil {
		log.Fatalf("clickhouse: %v", err)
	}
	buf := &buffer.Direct{Store: store}

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/traces", gateway.TracesHandler(buf))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })

	addr := getenv("APM_GATEWAY_ADDR", ":4318")
	log.Printf("gateway listening on %s (OTLP/HTTP)", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
```

- [ ] **Step 7: 빌드 확인 + Commit**

Run: `go build ./...`
Expected: 성공
```bash
git add gateway cmd/gateway go.mod go.sum
git commit -m "feat: OTLP/HTTP gateway receiver -> BufferPort

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 쿼리 서비스 REST API (`query` + `cmd/query`)

**Files:**
- Create: `query/api.go`
- Test: `query/api_test.go`
- Create: `cmd/query/main.go`

**Interfaces:**
- Consumes: `storage.Store` 조회 메서드 (`ListTransactions`, `GetTraceSpans`)
- Produces:
  - `type Reader interface { ListTransactions(...); GetTraceSpans(...) }`
  - `func Router(r Reader) http.Handler` — `GET /api/v1/transactions`, `GET /api/v1/traces/{traceID}/spans`
  - JSON DTO: `TransactionDTO`, `SpanDTO`

- [ ] **Step 1: 실패하는 테스트 작성 (fake reader)**

`query/api_test.go`:
```go
package query

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/heejune/apm/internal/otlp"
	"github.com/heejune/apm/internal/storage"
)

type fakeReader struct{}

func (fakeReader) ListTransactions(_ context.Context, tenant string, f storage.Filter) ([]storage.TransactionRow, error) {
	return []storage.TransactionRow{{
		TraceID: "aa11", ServiceName: "GatewayService", TransactionName: "GET /x",
		StatusCode: "OK", StartTime: time.Unix(0, 0).UTC(), DurationNs: 1424000000,
	}}, nil
}

func (fakeReader) GetTraceSpans(_ context.Context, tenant, traceID string) ([]otlp.Span, error) {
	return []otlp.Span{{TraceID: traceID, SpanID: "01", SpanName: "GET /x", SpanKind: "SERVER"}}, nil
}

func TestListTransactionsEndpoint(t *testing.T) {
	srv := httptest.NewServer(Router(fakeReader{}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/v1/transactions?limit=10")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var got []TransactionDTO
	json.NewDecoder(resp.Body).Decode(&got)
	if len(got) != 1 || got[0].TraceID != "aa11" || got[0].DurationMs != 1424 {
		t.Fatalf("dto = %+v", got)
	}
}

func TestTraceSpansEndpoint(t *testing.T) {
	srv := httptest.NewServer(Router(fakeReader{}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/v1/traces/aa11/spans")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []SpanDTO
	json.NewDecoder(resp.Body).Decode(&got)
	if len(got) != 1 || got[0].SpanID != "01" {
		t.Fatalf("dto = %+v", got)
	}
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `go test ./query/ -v`
Expected: FAIL — `undefined: Router`

- [ ] **Step 3: 구현**

`query/api.go`:
```go
package query

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/heejune/apm/internal/otlp"
	"github.com/heejune/apm/internal/storage"
)

const defaultTenant = "default" // Phase 4에서 인증 컨텍스트로 대체

type Reader interface {
	ListTransactions(ctx context.Context, tenant string, f storage.Filter) ([]storage.TransactionRow, error)
	GetTraceSpans(ctx context.Context, tenant, traceID string) ([]otlp.Span, error)
}

type TransactionDTO struct {
	TraceID         string `json:"traceId"`
	ServiceName     string `json:"serviceName"`
	TransactionName string `json:"transactionName"`
	StatusCode      string `json:"statusCode"`
	StartTime       string `json:"startTime"`
	DurationMs      int64  `json:"durationMs"`
}

type SpanDTO struct {
	TraceID      string `json:"traceId"`
	SpanID       string `json:"spanId"`
	ParentSpanID string `json:"parentSpanId"`
	ServiceName  string `json:"serviceName"`
	SpanName     string `json:"spanName"`
	SpanKind     string `json:"spanKind"`
	StartTime    string `json:"startTime"`
	DurationMs   int64  `json:"durationMs"`
	StatusCode   string `json:"statusCode"`
	HTTPMethod   string `json:"httpMethod,omitempty"`
	HTTPRoute    string `json:"httpRoute,omitempty"`
	DBSystem     string `json:"dbSystem,omitempty"`
	DBStatement  string `json:"dbStatement,omitempty"`
}

func Router(r Reader) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/transactions", func(w http.ResponseWriter, req *http.Request) {
		limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
		rows, err := r.ListTransactions(req.Context(), defaultTenant, storage.Filter{
			Service: req.URL.Query().Get("service"),
			Limit:   limit,
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]TransactionDTO, 0, len(rows))
		for _, t := range rows {
			out = append(out, TransactionDTO{
				TraceID: t.TraceID, ServiceName: t.ServiceName, TransactionName: t.TransactionName,
				StatusCode: t.StatusCode, StartTime: t.StartTime.Format("2006-01-02T15:04:05.000Z"),
				DurationMs: int64(t.DurationNs / 1_000_000),
			})
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("GET /api/v1/traces/{traceID}/spans", func(w http.ResponseWriter, req *http.Request) {
		spans, err := r.GetTraceSpans(req.Context(), defaultTenant, req.PathValue("traceID"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]SpanDTO, 0, len(spans))
		for _, s := range spans {
			out = append(out, SpanDTO{
				TraceID: s.TraceID, SpanID: s.SpanID, ParentSpanID: s.ParentSpanID,
				ServiceName: s.ServiceName, SpanName: s.SpanName, SpanKind: s.SpanKind,
				StartTime:  s.StartTime.Format("2006-01-02T15:04:05.000Z"),
				DurationMs: int64(s.DurationNs / 1_000_000), StatusCode: s.StatusCode,
				HTTPMethod: s.HTTPMethod, HTTPRoute: s.HTTPRoute,
				DBSystem: s.DBSystem, DBStatement: s.DBStatement,
			})
		}
		writeJSON(w, out)
	})
	return withCORS(mux)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func withCORS(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}
```

> 주의: `GET /api/v1/...` 패턴 라우팅은 Go 1.22+ `net/http` 메서드 패턴 기능. Global Constraints의 Go 1.22 하한이 이 때문.

- [ ] **Step 4: 테스트 통과 확인**

Run: `go test ./query/ -v`
Expected: PASS

- [ ] **Step 5: main 작성**

`cmd/query/main.go`:
```go
package main

import (
	"log"
	"net/http"
	"os"

	"github.com/heejune/apm/internal/storage"
	"github.com/heejune/apm/query"
)

func main() {
	dsn := getenv("APM_CH_DSN", "clickhouse://localhost:9000/apm")
	store, err := storage.New(dsn)
	if err != nil {
		log.Fatalf("clickhouse: %v", err)
	}
	addr := getenv("APM_QUERY_ADDR", ":8080")
	log.Printf("query service listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, query.Router(store)))
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
```

- [ ] **Step 6: 빌드 + Commit**

Run: `go build ./...`
```bash
git add query cmd/query
git commit -m "feat: query service REST API (transactions list + trace spans)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: React UI — 트랜잭션 리스트 + 트리뷰 (`web`)

**Files:**
- Create: `web/package.json`, `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`
- Create: `web/src/main.tsx`, `web/src/api.ts`, `web/src/App.tsx`
- Create: `web/src/TransactionTable.tsx`, `web/src/TraceTree.tsx`

**Interfaces:**
- Consumes: 쿼리 API `GET /api/v1/transactions`, `GET /api/v1/traces/{id}/spans`
- Produces: 브라우저 UI (테스트는 빌드 성공 + 수동/E2E로 확인)

- [ ] **Step 1: Vite React-TS 스캐폴드**

Run:
```bash
cd /Users/heejune/Desktop/projects/side/apm
npm create vite@latest web -- --template react-ts
cd web && npm install && npm install @tanstack/react-query
```

- [ ] **Step 2: API 클라이언트 작성**

`web/src/api.ts`:
```ts
const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8080";

export type Transaction = {
  traceId: string;
  serviceName: string;
  transactionName: string;
  statusCode: string;
  startTime: string;
  durationMs: number;
};

export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  serviceName: string;
  spanName: string;
  spanKind: string;
  startTime: string;
  durationMs: number;
  statusCode: string;
  httpMethod?: string;
  httpRoute?: string;
  dbSystem?: string;
  dbStatement?: string;
};

export async function fetchTransactions(): Promise<Transaction[]> {
  const r = await fetch(`${BASE}/api/v1/transactions?limit=100`);
  if (!r.ok) throw new Error(`transactions ${r.status}`);
  return r.json();
}

export async function fetchSpans(traceId: string): Promise<Span[]> {
  const r = await fetch(`${BASE}/api/v1/traces/${traceId}/spans`);
  if (!r.ok) throw new Error(`spans ${r.status}`);
  return r.json();
}
```

- [ ] **Step 3: 트랜잭션 테이블 컴포넌트**

`web/src/TransactionTable.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import { fetchTransactions, Transaction } from "./api";

export function TransactionTable({ onSelect }: { onSelect: (t: Transaction) => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["transactions"],
    queryFn: fetchTransactions,
    refetchInterval: 5000,
  });
  if (isLoading) return <div>로딩…</div>;
  if (error) return <div>에러: {String(error)}</div>;
  return (
    <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th align="left">서비스</th><th align="left">트랜잭션</th>
          <th align="left">상태</th><th align="right">경과(ms)</th>
        </tr>
      </thead>
      <tbody>
        {(data ?? []).map((t) => (
          <tr key={t.traceId + t.startTime} onClick={() => onSelect(t)}
              style={{ cursor: "pointer", borderTop: "1px solid #333" }}>
            <td>{t.serviceName}</td>
            <td>{t.transactionName}</td>
            <td style={{ color: t.statusCode === "ERROR" ? "#f66" : "#6c6" }}>{t.statusCode}</td>
            <td align="right">{t.durationMs.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: 트리뷰 컴포넌트 (부모-자식 조립 + 들여쓰기 바)**

`web/src/TraceTree.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import { fetchSpans, Span } from "./api";

type Node = Span & { children: Node[] };

function buildTree(spans: Span[]): Node[] {
  const byId = new Map<string, Node>();
  spans.forEach((s) => byId.set(s.spanId, { ...s, children: [] }));
  const roots: Node[] = [];
  byId.forEach((n) => {
    const parent = n.parentSpanId && byId.get(n.parentSpanId);
    if (parent) parent.children.push(n);
    else roots.push(n);
  });
  return roots;
}

function Row({ n, depth, max }: { n: Node; depth: number; max: number }) {
  const width = max > 0 ? Math.max(2, (n.durationMs / max) * 100) : 2;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
        <div style={{ paddingLeft: depth * 16, minWidth: 260, fontSize: 12 }}>
          {n.serviceName} · {n.spanName}
        </div>
        <div style={{ background: "#4a8", height: 10, width: `${width}%` }} />
        <div style={{ fontSize: 11, color: "#999" }}>{n.durationMs}ms</div>
      </div>
      {n.children.map((c) => <Row key={c.spanId} n={c} depth={depth + 1} max={max} />)}
    </>
  );
}

export function TraceTree({ traceId }: { traceId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["spans", traceId],
    queryFn: () => fetchSpans(traceId),
  });
  if (isLoading) return <div>로딩…</div>;
  const spans = data ?? [];
  const max = spans.reduce((m, s) => Math.max(m, s.durationMs), 0);
  return <div>{buildTree(spans).map((r) => <Row key={r.spanId} n={r} depth={0} max={max} />)}</div>;
}
```

- [ ] **Step 5: App 조립 (좌 리스트 / 우 트리)**

`web/src/App.tsx`:
```tsx
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TransactionTable } from "./TransactionTable";
import { TraceTree } from "./TraceTree";
import { Transaction } from "./api";

const qc = new QueryClient();

export default function App() {
  const [sel, setSel] = useState<Transaction | null>(null);
  return (
    <QueryClientProvider client={qc}>
      <div style={{ display: "flex", height: "100vh", background: "#111", color: "#ddd" }}>
        <div style={{ flex: 1, overflow: "auto", padding: 12, borderRight: "1px solid #333" }}>
          <h3>트레이스 분석</h3>
          <TransactionTable onSelect={setSel} />
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
          <h3>트리 뷰</h3>
          {sel ? <TraceTree traceId={sel.traceId} /> : <div>트랜잭션을 선택하세요</div>}
        </div>
      </div>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 6: 빌드 확인**

Run: `cd web && npm run build`
Expected: 빌드 성공(타입 에러 0)

- [ ] **Step 7: Commit**

```bash
cd /Users/heejune/Desktop/projects/side/apm
git add web
git commit -m "feat: web UI — transaction list + trace tree

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Java 데모앱 + 표준 OTel javaagent

**Files:**
- Create: `demo/java/build.gradle`, `demo/java/settings.gradle`
- Create: `demo/java/src/main/java/com/example/demo/DemoApplication.java`
- Create: `demo/java/README.md`

**Interfaces:**
- Consumes: 게이트웨이 `POST /v1/traces` (OTLP/HTTP)
- Produces: HTTP 엔드포인트 2개(서로 호출)로 멀티스팬 트레이스 생성

- [ ] **Step 1: Spring Boot 앱 작성 (엔드포인트가 내부 HTTP 호출 → 자식 CLIENT 스팬)**

`demo/java/src/main/java/com/example/demo/DemoApplication.java`:
```java
package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;

@SpringBootApplication
@RestController
public class DemoApplication {
    private final RestClient client = RestClient.create();

    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }

    @GetMapping("/buy-request")
    public String buyRequest() {
        // 자기 자신의 /inventory 호출 → CLIENT + SERVER 자식 스팬 생성
        String inv = client.get()
            .uri("http://localhost:8081/inventory")
            .retrieve().body(String.class);
        return "ordered: " + inv;
    }

    @GetMapping("/inventory")
    public String inventory() throws InterruptedException {
        Thread.sleep(120); // 소요시간 티나게
        return "in-stock";
    }
}
```

`demo/java/build.gradle`:
```groovy
plugins { id 'org.springframework.boot' version '3.3.2'; id 'io.spring.dependency-management' version '1.1.6'; id 'java' }
group = 'com.example'
java { sourceCompatibility = '17' }
repositories { mavenCentral() }
dependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }
```
`demo/java/settings.gradle`: `rootProject.name = 'demo'`

- [ ] **Step 2: OTel javaagent 다운로드 스크립트 겸 실행법 문서화**

`demo/java/README.md`:
```md
# 데모 실행

1. javaagent 다운로드:
   curl -L -o opentelemetry-javaagent.jar \
     https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar

2. 앱 빌드:
   ./gradlew bootJar

3. 게이트웨이(:4318)와 ClickHouse가 떠 있는 상태에서 실행:
   OTEL_SERVICE_NAME=GatewayService \
   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
   OTEL_TRACES_EXPORTER=otlp OTEL_METRICS_EXPORTER=none OTEL_LOGS_EXPORTER=none \
   java -javaagent:opentelemetry-javaagent.jar -jar build/libs/demo.jar

4. 트래픽 발생:
   curl http://localhost:8080/buy-request
```

> 참고: `/inventory`가 8081이 아니라 8080이면 자기호출이 안 되니, 데모 단순화를 위해 한 앱이 8080에서 두 엔드포인트를 서비스하고 `/buy-request`가 `http://localhost:8080/inventory`를 호출하도록 URI를 8080으로 맞춘다(위 코드의 8081을 8080으로 수정).

- [ ] **Step 3: 수동 검증 (관통 일부)**

Run:
```bash
docker compose -f deploy/docker-compose.yml up -d clickhouse && sleep 8
go run ./cmd/gateway &   # :4318
cd demo/java && ./gradlew bootJar && \
  OTEL_SERVICE_NAME=GatewayService OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_TRACES_EXPORTER=otlp \
  OTEL_METRICS_EXPORTER=none OTEL_LOGS_EXPORTER=none \
  java -javaagent:opentelemetry-javaagent.jar -jar build/libs/demo.jar &
sleep 15 && curl -s http://localhost:8080/buy-request
```
Expected: `ordered: in-stock`, 그리고 ClickHouse에 스팬 적재:
```bash
docker compose -f deploy/docker-compose.yml exec clickhouse \
  clickhouse-client -q "SELECT count() FROM apm.spans WHERE service_name='GatewayService'"
```
Expected: `> 0`

- [ ] **Step 4: Commit**

```bash
git add demo/java
git commit -m "feat: Java Spring Boot demo app instrumented via OTel javaagent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 전체 스택 docker-compose + E2E 관통 수용 테스트

**Files:**
- Modify: `deploy/docker-compose.yml` (gateway/query/web 추가)
- Create: `cmd/gateway/Dockerfile`, `cmd/query/Dockerfile`, `web/Dockerfile`
- Create: `deploy/README.md`

**Interfaces:**
- Consumes: 앞선 모든 컴포넌트
- Produces: `docker compose up` 원커맨드 스택 + 수용 기준 검증 절차

- [ ] **Step 1: Go 서비스 Dockerfile (멀티스테이지)**

`cmd/gateway/Dockerfile`:
```dockerfile
FROM golang:1.22 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /gateway ./cmd/gateway
FROM gcr.io/distroless/static-debian12
COPY --from=build /gateway /gateway
EXPOSE 4318
ENTRYPOINT ["/gateway"]
```
`cmd/query/Dockerfile` (동일 패턴, `./cmd/query`, `/query`, `EXPOSE 8080`).

- [ ] **Step 2: web Dockerfile (빌드 → nginx 정적 서빙)**

`web/Dockerfile`:
```dockerfile
FROM node:20 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE=http://localhost:8080
ENV VITE_API_BASE=$VITE_API_BASE
RUN npm run build
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

- [ ] **Step 3: compose에 서비스 추가**

`deploy/docker-compose.yml`에 추가:
```yaml
  gateway:
    build: { context: .., dockerfile: cmd/gateway/Dockerfile }
    environment: { APM_CH_DSN: "clickhouse://clickhouse:9000/apm" }
    ports: ["4318:4318"]
    depends_on: [clickhouse]
  query:
    build: { context: .., dockerfile: cmd/query/Dockerfile }
    environment: { APM_CH_DSN: "clickhouse://clickhouse:9000/apm" }
    ports: ["8080:8080"]
    depends_on: [clickhouse]
  web:
    build: { context: ../web, dockerfile: Dockerfile }
    ports: ["3000:80"]
    depends_on: [query]
```
> `context: ..`는 compose 파일이 `deploy/`에 있으므로 리포 루트를 빌드 컨텍스트로 삼기 위함.

- [ ] **Step 4: README 실행법**

`deploy/README.md`:
```md
# 실행
docker compose -f deploy/docker-compose.yml up -d --build
# UI: http://localhost:3000 · Query API: http://localhost:8080 · OTLP: http://localhost:4318

# 데모 트래픽(별도 터미널, demo/java/README.md 참고)
curl http://localhost:8080/buy-request   # 데모앱 실행 중일 때
```

- [ ] **Step 5: E2E 관통 수용 테스트 (수동)**

절차:
1. `docker compose -f deploy/docker-compose.yml up -d --build`
2. `demo/java/README.md`대로 데모앱 실행(javaagent, 엔드포인트는 호스트 :4318로 전송)
3. `curl http://localhost:8080/buy-request` 수 회
4. 브라우저 `http://localhost:3000` 열기

Expected(수용 기준):
- 좌측 "트레이스 분석"에 `GatewayService /buy-request` 트랜잭션들이 나타난다.
- 행 클릭 시 우측 "트리 뷰"에 부모(SERVER `/buy-request`) → 자식(CLIENT HTTP 호출, 자식 SERVER `/inventory`) 스팬이 소요시간 바와 함께 보인다.
- `GET /api/v1/transactions` 가 JSON 배열을 반환한다.

- [ ] **Step 6: Commit**

```bash
git add deploy cmd/gateway/Dockerfile cmd/query/Dockerfile web/Dockerfile
git commit -m "feat: full-stack docker-compose + E2E acceptance (app to UI 관통)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (Phase 1 범위 기준):**
- OTLP 수신(게이트웨이) → Task 5 ✓ · BufferPort/DirectBuffer → Task 4 ✓ · ClickHouse `spans` 저장 → Task 1,3 ✓ · 쿼리 API(리스트/트리) → Task 6 ✓ · UI(리스트+트리뷰) → Task 7 ✓ · Java 데모 한 줄 계측 → Task 8 ✓ · docker-compose 관통 → Task 9 ✓.
- Phase 1에서 **의도적으로 제외**(스펙상 이후 Phase): 파생 MV(trace_summary/red_rollup/service_edges), 서비스맵·RED 화면, Kafka/DLQ, 멀티테넌시/인증, enrichment, 커스텀 distro, Node 데모. → 아래 로드맵.

**2. Placeholder scan:** 모든 코드 스텝에 실제 코드 포함, "TODO/적절히 처리" 없음. ✓

**3. Type consistency:** `otlp.Span`(Task 2) 필드를 storage(Task 3)·buffer(Task 4)·gateway(Task 5)·query(Task 6)가 동일 사용. `buffer.Port.Publish([]otlp.Span)`·`storage.Filter`·`storage.TransactionRow`·`TransactionDTO/SpanDTO` 명칭 태스크 간 일치. Go 1.22 `net/http` 메서드 패턴 사용 → Global Constraints의 1.22 하한과 정합. ✓

---

## 이후 Phase 로드맵 (각각 별도 계획으로 상세화)

- **Phase 2 — 파생 MV + 화면 확장:** `trace_summary`(AggregatingMergeTree MV) + 레코드요약 API/화면, `red_rollup` + RED 대시보드, `service_edges` + 서비스맵. (와탭 레코드요약/토폴로지 재현)
- **Phase 3 — Kafka 경로:** `KafkaBuffer`(idempotent producer, key=trace_id) + Writer 컨슈머 + DLQ + 백프레셔. BufferPort 뒤 교체.
- **Phase 4 — 멀티테넌시·인증·enrichment:** Postgres control-plane(tenants/api_keys), 게이트웨이 API key 인증→tenant_id 강제, GeoIP/UA enrichment, 쿼리 테넌트 격리(서버측 컨텍스트), UI 로그인.
- **Phase 5 — 커스텀 distro·온보딩:** Java javaagent 배포판(extension), Node npm 패키지, 온보딩 화면(키 발급·설치확인 ✅), Node 데모.
- **Phase 6 — 운영화:** 보존 티어, k8s/helm, 자기관측(dogfood) 대시보드, 로드/소크 테스트.

이후: ②실시간 X-View(WS) · ③메트릭 · ④로그 · 알림 · 프로파일링 · RUM.
