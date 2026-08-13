# APM Phase 2B — 서비스맵 + 실시간 X-View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** (1) 서비스 의존성 맵(토폴로지)을 spans 셀프조인으로 계산해 그래프로 그리고, (2) 제니퍼/와탭식 실시간 X-View(응답시간 스캐터)를 SSE 라이브 스트림으로 제공한다.

**Architecture:** 서비스맵은 쿼리 시점 self-join(child.parent_span_id = parent.span_id)으로 caller→callee 간선을 집계하고 노드는 spans의 distinct service_name(시간창 한정)에서 얻는다. X-View는 `GET /api/v1/live/transactions` **SSE** 엔드포인트가 최근 루트 트랜잭션(parent_span_id='')을 spans(시간정렬)에서 폴링해 새 것만 push하고, 브라우저 `EventSource` + ECharts 스캐터가 (시각×소요시간, 에러색)으로 라이브 렌더한다. 단일 테넌트 "default".

**Tech Stack:** ClickHouse(self-join, time-range scan), Go(net/http SSE, http.Flusher — WS 라이브러리 불필요), React+TS, ECharts(graph + scatter).

## Global Constraints

- Go module `github.com/heejune/apm`. Go 1.22+. Commit footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- ClickHouse via HTTP; `storage.New(clickhouse://host:9000/apm)` (unchanged). Integration tests gated on `APM_TEST_CH_DSN=clickhouse://localhost:8123/apm`.
- tenant_id = server-side const "default"; never from client. All SQL parameterized.
- Durations on the wire = `float64` ms (ns/1e6), consistent with Phase 1/2A.
- **VERIFIED**: the service-edge self-join was prototyped live against CH 24.8 (returns from/to/calls/errors/avg_ms). Node list = `SELECT DISTINCT service_name FROM apm.spans` (all services, NOT red_rollup which is SERVER-only per Phase 2A note M2).

## File Structure

```
internal/storage/servicemap.go        -- ServiceNode, ServiceEdge, LiveTxn types + queries
internal/storage/servicemap_test.go   -- integration tests
query/servicemap_api.go               -- /servicemap endpoint + /live/transactions SSE
query/servicemap_api_test.go          -- endpoint tests (servicemap; SSE smoke)
web/src/ServiceMap.tsx                 -- ECharts graph
web/src/XView.tsx                      -- EventSource + ECharts scatter
web/src/api.ts                         -- add types + fetchers (modify)
web/src/App.tsx                        -- add nav tabs 서비스맵 / X-View (modify)
```

---

### Task 1: 서비스맵 조회 (self-join + nodes)

**Files:**
- Create: `internal/storage/servicemap.go`
- Test: `internal/storage/servicemap_test.go`

**Interfaces:**
- Produces:
  - `type ServiceNode struct { Name string; RequestCount, ErrorCount uint64 }`
  - `type ServiceEdge struct { From, To string; CallCount, ErrorCount uint64; AvgMs float64 }`
  - `type ServiceMap struct { Nodes []ServiceNode; Edges []ServiceEdge }`
  - `func (s *Store) GetServiceMap(ctx context.Context, tenantID string, from, to time.Time) (ServiceMap, error)`

- [ ] **Step 1: Write failing integration test**

`internal/storage/servicemap_test.go`:
```go
package storage

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/heejune/apm/internal/otlp"
)

func testStoreSM(t *testing.T) *Store {
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

func TestGetServiceMap(t *testing.T) {
	s := testStoreSM(t)
	ctx := context.Background()
	now := time.Now().UTC()
	tr := "sm_" + now.Format("150405.000000000")
	// A(root SERVER) -> A(CLIENT) -> B(SERVER child): edge A->B
	spans := []otlp.Span{
		{TenantID: "default", TraceID: tr, SpanID: "a_srv", ParentSpanID: "", ServiceName: "Amap",
			SpanName: "GET /a", SpanKind: "SERVER", StartTime: now, DurationNs: 100_000_000, StatusCode: "OK",
			ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
		{TenantID: "default", TraceID: tr, SpanID: "a_cli", ParentSpanID: "a_srv", ServiceName: "Amap",
			SpanName: "GET", SpanKind: "CLIENT", StartTime: now, DurationNs: 60_000_000, StatusCode: "OK",
			HTTPURL: "http://b", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
		{TenantID: "default", TraceID: tr, SpanID: "b_srv", ParentSpanID: "a_cli", ServiceName: "Bmap",
			SpanName: "GET /b", SpanKind: "SERVER", StartTime: now, DurationNs: 50_000_000, StatusCode: "OK",
			ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
	}
	if err := s.InsertSpans(ctx, spans); err != nil {
		t.Fatalf("insert: %v", err)
	}
	sm, err := s.GetServiceMap(ctx, "default", now.Add(-2*time.Minute), now.Add(2*time.Minute))
	if err != nil {
		t.Fatalf("GetServiceMap: %v", err)
	}
	hasNode := func(n string) bool {
		for _, x := range sm.Nodes { if x.Name == n { return true } }
		return false
	}
	if !hasNode("Amap") || !hasNode("Bmap") {
		t.Fatalf("nodes missing: %+v", sm.Nodes)
	}
	found := false
	for _, e := range sm.Edges {
		if e.From == "Amap" && e.To == "Bmap" && e.CallCount >= 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("edge Amap->Bmap missing: %+v", sm.Edges)
	}
}
```

- [ ] **Step 2: Run — expect FAIL** (`undefined: GetServiceMap`)

Run: `export PATH="/opt/homebrew/bin:$PATH"; APM_TEST_CH_DSN="clickhouse://localhost:8123/apm" go test ./internal/storage/ -run TestGetServiceMap -v`
Expected: build failure.

- [ ] **Step 3: Implement**

`internal/storage/servicemap.go`:
```go
package storage

import (
	"context"
	"time"
)

type ServiceNode struct {
	Name         string
	RequestCount uint64
	ErrorCount   uint64
}

type ServiceEdge struct {
	From       string
	To         string
	CallCount  uint64
	ErrorCount uint64
	AvgMs      float64
}

type ServiceMap struct {
	Nodes []ServiceNode `json:"nodes"`
	Edges []ServiceEdge `json:"edges"`
}

func (s *Store) GetServiceMap(ctx context.Context, tenantID string, from, to time.Time) (ServiceMap, error) {
	var sm ServiceMap

	// Nodes: all services seen in the window, with SERVER request/error counts.
	const nodeQ = `
SELECT service_name,
       countIf(span_kind = 'SERVER') AS reqs,
       countIf(span_kind = 'SERVER' AND status_code = 'ERROR') AS errs
FROM apm.spans
WHERE tenant_id = ? AND start_time >= ? AND start_time <= ?
GROUP BY service_name
ORDER BY service_name`
	nrows, err := s.db.QueryContext(ctx, nodeQ, tenantID, from, to)
	if err != nil {
		return sm, err
	}
	defer nrows.Close()
	for nrows.Next() {
		var n ServiceNode
		if err := nrows.Scan(&n.Name, &n.RequestCount, &n.ErrorCount); err != nil {
			return sm, err
		}
		sm.Nodes = append(sm.Nodes, n)
	}
	if err := nrows.Err(); err != nil {
		return sm, err
	}

	// Edges: caller(parent span's service) -> callee(child SERVER span's service).
	const edgeQ = `
SELECT parent.service_name AS from_service,
       child.service_name  AS to_service,
       count() AS calls,
       countIf(child.status_code = 'ERROR') AS errors,
       avg(child.duration_ns) / 1e6 AS avg_ms
FROM apm.spans AS child
INNER JOIN apm.spans AS parent
  ON child.tenant_id = parent.tenant_id
     AND child.trace_id = parent.trace_id
     AND child.parent_span_id = parent.span_id
WHERE child.tenant_id = ? AND child.span_kind = 'SERVER' AND child.parent_span_id != ''
  AND child.start_time >= ? AND child.start_time <= ?
GROUP BY from_service, to_service
ORDER BY calls DESC`
	erows, err := s.db.QueryContext(ctx, edgeQ, tenantID, from, to)
	if err != nil {
		return sm, err
	}
	defer erows.Close()
	for erows.Next() {
		var e ServiceEdge
		if err := erows.Scan(&e.From, &e.To, &e.CallCount, &e.ErrorCount, &e.AvgMs); err != nil {
			return sm, err
		}
		sm.Edges = append(sm.Edges, e)
	}
	return sm, erows.Err()
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `export PATH="/opt/homebrew/bin:$PATH"; APM_TEST_CH_DSN="clickhouse://localhost:8123/apm" go test ./internal/storage/ -run TestGetServiceMap -v`
Expected: PASS (nodes Amap,Bmap; edge Amap->Bmap).

- [ ] **Step 5: Commit**

```bash
git add internal/storage/servicemap.go internal/storage/servicemap_test.go
git commit -m "feat: GetServiceMap (self-join edges + service nodes)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 최근 트랜잭션 조회 (X-View 데이터 소스)

**Files:**
- Modify: `internal/storage/servicemap.go`
- Test: `internal/storage/servicemap_test.go`

**Interfaces:**
- Produces:
  - `type LiveTxn struct { TraceID, Service, Transaction, StatusCode string; StartTime time.Time; DurationMs float64; IsError bool }`
  - `func (s *Store) RecentRootTxns(ctx context.Context, tenantID string, since time.Time, limit int) ([]LiveTxn, error)`

- [ ] **Step 1: Write failing test**

Append to `internal/storage/servicemap_test.go`:
```go
func TestRecentRootTxns(t *testing.T) {
	s := testStoreSM(t)
	ctx := context.Background()
	now := time.Now().UTC()
	tr := "lt_" + now.Format("150405.000000000")
	spans := []otlp.Span{
		{TenantID: "default", TraceID: tr, SpanID: "root", ParentSpanID: "", ServiceName: "LiveSvc",
			SpanName: "GET /live", SpanKind: "SERVER", StartTime: now, DurationNs: 42_000_000, StatusCode: "OK",
			HTTPRoute: "/live", ResourceAttrs: map[string]string{}, SpanAttrs: map[string]string{}},
	}
	if err := s.InsertSpans(ctx, spans); err != nil {
		t.Fatalf("insert: %v", err)
	}
	txns, err := s.RecentRootTxns(ctx, "default", now.Add(-1*time.Minute), 100)
	if err != nil {
		t.Fatalf("RecentRootTxns: %v", err)
	}
	found := false
	for _, x := range txns {
		if x.TraceID == tr {
			found = true
			if x.Service != "LiveSvc" || x.DurationMs < 41 || x.DurationMs > 43 {
				t.Errorf("bad txn: %+v", x)
			}
		}
	}
	if !found {
		t.Fatalf("recent txn %s not found in %d rows", tr, len(txns))
	}
}
```

- [ ] **Step 2: Run — expect FAIL** (`undefined: RecentRootTxns`)

- [ ] **Step 3: Implement (append to servicemap.go)**

```go
type LiveTxn struct {
	TraceID     string
	Service     string
	Transaction string
	StatusCode  string
	StartTime   time.Time
	DurationMs  float64
	IsError     bool
}

func (s *Store) RecentRootTxns(ctx context.Context, tenantID string, since time.Time, limit int) ([]LiveTxn, error) {
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	const q = `
SELECT trace_id, service_name, http_route, span_name, status_code, start_time, duration_ns / 1e6 AS ms
FROM apm.spans
WHERE tenant_id = ? AND parent_span_id = '' AND start_time > ?
ORDER BY start_time ASC
LIMIT ?`
	rows, err := s.db.QueryContext(ctx, q, tenantID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LiveTxn
	for rows.Next() {
		var x LiveTxn
		var route, name string
		if err := rows.Scan(&x.TraceID, &x.Service, &route, &name, &x.StatusCode, &x.StartTime, &x.DurationMs); err != nil {
			return nil, err
		}
		x.Transaction = route
		if x.Transaction == "" {
			x.Transaction = name
		}
		x.IsError = x.StatusCode == "ERROR"
		out = append(out, x)
	}
	return out, rows.Err()
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `export PATH="/opt/homebrew/bin:$PATH"; APM_TEST_CH_DSN="clickhouse://localhost:8123/apm" go test ./internal/storage/ -run TestRecentRootTxns -v`

- [ ] **Step 5: Commit**

```bash
git add internal/storage/servicemap.go internal/storage/servicemap_test.go
git commit -m "feat: RecentRootTxns for live X-View stream

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Query API — servicemap 엔드포인트 + X-View SSE 스트림

**Files:**
- Create: `query/servicemap_api.go`
- Test: `query/servicemap_api_test.go`
- Modify: `query/api.go` (extend Reader; call registerServiceMap in Router)

**Interfaces:**
- Consumes: `storage.GetServiceMap`, `storage.RecentRootTxns`.
- Produces:
  - `GET /api/v1/servicemap?from&to` → `{nodes:[{name,requestCount,errorCount}], edges:[{from,to,callCount,errorCount,avgMs}]}`
  - `GET /api/v1/live/transactions` → **SSE** stream, each event `data: {json LiveTxnDTO}\n\n`, polling every ~1s, pushing new root txns.

- [ ] **Step 1: Extend Reader + write servicemap endpoint test (SSE tested via smoke)**

`query/servicemap_api_test.go`:
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

type fakeSM struct{ fakeDerived }

func (fakeSM) GetServiceMap(_ context.Context, _ string, _, _ time.Time) (storage.ServiceMap, error) {
	return storage.ServiceMap{
		Nodes: []storage.ServiceNode{{Name: "A", RequestCount: 5}},
		Edges: []storage.ServiceEdge{{From: "A", To: "B", CallCount: 3, AvgMs: 12.5}},
	}, nil
}
func (fakeSM) RecentRootTxns(_ context.Context, _ string, _ time.Time, _ int) ([]storage.LiveTxn, error) {
	return []storage.LiveTxn{{TraceID: "t1", Service: "A", DurationMs: 42, IsError: false}}, nil
}

func TestServiceMapEndpoint(t *testing.T) {
	srv := httptest.NewServer(Router(fakeSM{}))
	defer srv.Close()
	resp, _ := http.Get(srv.URL + "/api/v1/servicemap")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var sm ServiceMapDTO
	json.NewDecoder(resp.Body).Decode(&sm)
	if len(sm.Nodes) != 1 || sm.Nodes[0].Name != "A" || len(sm.Edges) != 1 || sm.Edges[0].To != "B" {
		t.Fatalf("dto %+v", sm)
	}
}
```
> SSE endpoint is verified in the controller's live E2E (curl the stream), not in unit tests — a streaming handler with a ticker is awkward to unit-test and would flake. The handler must still compile and be registered.

- [ ] **Step 2: Run — expect FAIL** (Reader lacks methods; DTO undefined)

- [ ] **Step 3: Extend Reader in query/api.go**

Add to the `Reader` interface:
```go
	GetServiceMap(ctx context.Context, tenant string, from, to time.Time) (storage.ServiceMap, error)
	RecentRootTxns(ctx context.Context, tenant string, since time.Time, limit int) ([]storage.LiveTxn, error)
```

- [ ] **Step 4: Implement handlers**

`query/servicemap_api.go`:
```go
package query

import (
	"encoding/json"
	"net/http"
	"time"
)

type ServiceNodeDTO struct {
	Name         string `json:"name"`
	RequestCount uint64 `json:"requestCount"`
	ErrorCount   uint64 `json:"errorCount"`
}
type ServiceEdgeDTO struct {
	From       string  `json:"from"`
	To         string  `json:"to"`
	CallCount  uint64  `json:"callCount"`
	ErrorCount uint64  `json:"errorCount"`
	AvgMs      float64 `json:"avgMs"`
}
type ServiceMapDTO struct {
	Nodes []ServiceNodeDTO `json:"nodes"`
	Edges []ServiceEdgeDTO `json:"edges"`
}
type LiveTxnDTO struct {
	TraceID     string  `json:"traceId"`
	Service     string  `json:"service"`
	Transaction string  `json:"transaction"`
	StatusCode  string  `json:"statusCode"`
	StartTime   string  `json:"startTime"`
	DurationMs  float64 `json:"durationMs"`
	IsError     bool    `json:"isError"`
}

func registerServiceMap(mux *http.ServeMux, r Reader) {
	mux.HandleFunc("GET /api/v1/servicemap", func(w http.ResponseWriter, req *http.Request) {
		to := time.Now().UTC()
		from := to.Add(-15 * time.Minute)
		if v := req.URL.Query().Get("from"); v != "" {
			if p, err := time.Parse(time.RFC3339, v); err == nil {
				from = p
			}
		}
		if v := req.URL.Query().Get("to"); v != "" {
			if p, err := time.Parse(time.RFC3339, v); err == nil {
				to = p
			}
		}
		sm, err := r.GetServiceMap(req.Context(), defaultTenant, from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := ServiceMapDTO{Nodes: []ServiceNodeDTO{}, Edges: []ServiceEdgeDTO{}}
		for _, n := range sm.Nodes {
			out.Nodes = append(out.Nodes, ServiceNodeDTO{n.Name, n.RequestCount, n.ErrorCount})
		}
		for _, e := range sm.Edges {
			out.Edges = append(out.Edges, ServiceEdgeDTO{e.From, e.To, e.CallCount, e.ErrorCount, e.AvgMs})
		}
		writeJSON(w, out)
	})

	// SSE live X-View stream: push new root transactions as they appear.
	mux.HandleFunc("GET /api/v1/live/transactions", func(w http.ResponseWriter, req *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "stream unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("Access-Control-Allow-Origin", "*")

		ctx := req.Context()
		since := time.Now().UTC().Add(-5 * time.Second)
		seen := make(map[string]struct{})
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				txns, err := r.RecentRootTxns(ctx, defaultTenant, since, 500)
				if err != nil {
					continue
				}
				for _, x := range txns {
					if _, dup := seen[x.TraceID]; dup {
						continue
					}
					seen[x.TraceID] = struct{}{}
					if x.StartTime.After(since) {
						since = x.StartTime
					}
					b, _ := json.Marshal(LiveTxnDTO{
						TraceID: x.TraceID, Service: x.Service, Transaction: x.Transaction,
						StatusCode: x.StatusCode, StartTime: x.StartTime.Format(time.RFC3339Nano),
						DurationMs: x.DurationMs, IsError: x.IsError,
					})
					_, _ = w.Write([]byte("data: "))
					_, _ = w.Write(b)
					_, _ = w.Write([]byte("\n\n"))
				}
				// prune seen set occasionally to bound memory
				if len(seen) > 5000 {
					seen = make(map[string]struct{})
				}
				flusher.Flush()
			}
		}
	})
}
```

- [ ] **Step 5: Call registerServiceMap in Router**

In `query/api.go` `Router`, add `registerServiceMap(mux, r)` before `return withCORS(mux)` (alongside `registerDerived`).

- [ ] **Step 6: Run — expect PASS**

Run: `export PATH="/opt/homebrew/bin:$PATH"; go test ./query/ -v`
Expected: all pass (servicemap endpoint test + existing). SSE handler compiles.

> Note: the existing fakes must satisfy the widened Reader. Add stub `GetServiceMap`/`RecentRootTxns` to whichever fake type is used across query tests so the package compiles (mirror how Phase 2A added methods to fakeReader/fakeDerived). Verify ALL query tests pass.

- [ ] **Step 7: Commit**

```bash
git add query/servicemap_api.go query/servicemap_api_test.go query/api.go
git commit -m "feat: servicemap endpoint + live X-View SSE stream

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: UI — 서비스맵 그래프 + X-View 스캐터

**Files:**
- Modify: `web/src/api.ts`
- Create: `web/src/ServiceMap.tsx`
- Create: `web/src/XView.tsx`
- Modify: `web/src/App.tsx` (nav tabs: 트레이스 분석 / RED 대시보드 / 서비스맵 / X-View)

- [ ] **Step 1: api.ts additions**

Append to `web/src/api.ts`:
```ts
export type ServiceMapData = {
  nodes: { name: string; requestCount: number; errorCount: number }[];
  edges: { from: string; to: string; callCount: number; errorCount: number; avgMs: number }[];
};
export async function fetchServiceMap(): Promise<ServiceMapData> {
  const r = await fetch(`${BASE}/api/v1/servicemap`);
  if (!r.ok) throw new Error(`servicemap ${r.status}`);
  return r.json();
}
export type LiveTxn = {
  traceId: string; service: string; transaction: string; statusCode: string;
  startTime: string; durationMs: number; isError: boolean;
};
export function liveTxnStream(onTxn: (t: LiveTxn) => void): () => void {
  const es = new EventSource(`${BASE}/api/v1/live/transactions`);
  es.onmessage = (e) => { try { onTxn(JSON.parse(e.data)); } catch {} };
  return () => es.close();
}
```

- [ ] **Step 2: ServiceMap component (ECharts graph)**

`web/src/ServiceMap.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { fetchServiceMap } from "./api";

export function ServiceMap() {
  const { data } = useQuery({ queryKey: ["servicemap"], queryFn: fetchServiceMap, refetchInterval: 10000 });
  const nodes = (data?.nodes ?? []).map((n) => ({
    name: n.name,
    symbolSize: Math.min(60, 20 + n.requestCount),
    itemStyle: { color: n.errorCount > 0 ? "#e66" : "#4a8" },
  }));
  const links = (data?.edges ?? []).map((e) => ({
    source: e.from, target: e.to,
    label: { show: true, formatter: `${e.callCount} · ${e.avgMs.toFixed(0)}ms` },
    lineStyle: { color: e.errorCount > 0 ? "#e66" : "#888", width: 2, curveness: 0.1 },
  }));
  const option = {
    backgroundColor: "transparent",
    tooltip: {},
    series: [{
      type: "graph", layout: "force", roam: true, draggable: true,
      label: { show: true, color: "#ddd" },
      force: { repulsion: 260, edgeLength: 160 },
      edgeSymbol: ["none", "arrow"],
      data: nodes, links,
    }],
  };
  return <ReactECharts option={option} style={{ height: "calc(100vh - 46px)" }} theme="dark" />;
}
```

- [ ] **Step 3: XView component (EventSource scatter)**

`web/src/XView.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { liveTxnStream, LiveTxn } from "./api";

type Point = { value: [number, number]; isError: boolean };

export function XView() {
  const [points, setPoints] = useState<Point[]>([]);
  const buf = useRef<Point[]>([]);

  useEffect(() => {
    const close = liveTxnStream((t: LiveTxn) => {
      const ts = new Date(t.startTime).getTime();
      buf.current = [...buf.current, { value: [ts, t.durationMs], isError: t.isError }].slice(-500);
    });
    const iv = setInterval(() => setPoints([...buf.current]), 1000);
    return () => { close(); clearInterval(iv); };
  }, []);

  const option = {
    backgroundColor: "transparent",
    tooltip: { formatter: (p: any) => `${p.value[1].toFixed(1)} ms` },
    xAxis: { type: "time", axisLabel: { color: "#999" } },
    yAxis: { type: "value", name: "ms", axisLabel: { color: "#999" } },
    series: [{
      type: "scatter", symbolSize: 7,
      data: points.map((p) => ({ value: p.value, itemStyle: { color: p.isError ? "#e66" : "#4af" } })),
    }],
  };
  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>실시간 X-View · 최근 트랜잭션 {points.length}건 (파랑=정상, 빨강=에러)</div>
      <ReactECharts option={option} style={{ height: "calc(100vh - 90px)" }} theme="dark" notMerge={false} lazyUpdate />
    </div>
  );
}
```

- [ ] **Step 4: App.tsx nav (add 서비스맵 / X-View tabs)**

Extend the `tab` union to `"trace" | "red" | "map" | "xview"` and add nav links + render `<ServiceMap/>` and `<XView/>`. Keep existing trace/red rendering. (Follow the existing nav pattern in App.tsx.)

- [ ] **Step 5: Build**

Run: `cd web && npm run build`
Expected: 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat: UI service map graph + live X-View scatter (SSE)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** service map (T1 storage + T3 API + T4 UI) + real-time X-View (T2 storage + T3 SSE + T4 UI). Covers Phase 2B scope. Live active-in-flight span tracking (true "active status") remains R (needs agent-side active reporting).

**Placeholders:** none — self-join verified live; SSE uses stdlib http.Flusher (no WS dep); ECharts graph/scatter concrete.

**Type consistency:** ServiceMap/ServiceEdge/ServiceNode/LiveTxn (storage) → Reader methods → *DTO (query) → web types align on names + float ms. Reader extension mirrors Phase 2A (add stubs to fakes so query package compiles).

**Known nuances (accepted / deferred):**
- Nodes from `spans` DISTINCT (all services), NOT red_rollup — resolves Phase 2A M2.
- Service-map self-join scans spans over the window; fine at Phase-2B scale, MV-optimize later (R).
- SSE stream polls every 1s from spans (time-bounded); true in-flight active transactions (before completion) = R.
- SSE endpoint verified by controller live E2E (curl the stream), not unit tests (streaming handler is flaky to unit-test).

## 이후
Phase 3 (런타임/인프라 메트릭 + 메인 대시보드 KPI), Phase 4 (로그+상관 · 멀티테넌시 · enrich), Phase 5 (distro/온보딩). 기능 카탈로그의 R 항목은 우선순위에 따라.
