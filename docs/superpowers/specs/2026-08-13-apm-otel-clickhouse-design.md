# APM 플랫폼 설계 — OTel + ClickHouse 위 자체 구현

- 날짜: 2026-08-13
- 상태: 설계 승인 완료, 구현 계획 대기
- 참조: SignOz(아키텍처 레퍼런스), 와탭/제니퍼소프트/Datadog/New Relic(기능·UX 참조)

## 1. 목적과 결정 요약

운영급(production-grade) APM 플랫폼을 **직접 구현**한다. 상업화·커스터마이징 자유를 확보하기
위해 관대한 라이선스 스택 위에 자체 계층을 올린다.

| 결정 | 내용 | 근거 |
|---|---|---|
| 목적 | 처음부터 운영급 설계, 상업화 자유 | 사용자 확정 |
| 구축 경계 | OTel SDK/Collector(Apache2) **채택** + 얇은 커스텀 distro. 저장 스키마·인입·쿼리·UI는 **자체 구현** | 생태계 호환 + 완전한 통제권 |
| 첫 기둥 | **분산 트레이싱 등뼈** (→ 서비스맵·RED·X-View 토대) | 넷 기능이 하나의 파이프라인 공유; 트레이스가 등뼈 |
| 인입 토폴로지 | **자체 OTLP 게이트웨이 + Kafka 버퍼 + ClickHouse Writer** (C안) | 운영급 제어·확장·재처리 여지 |
| 첫 타깃 런타임 | Java + Node (OTLP라 이후 언어 무관) | 와탭/제니퍼 = JVM 한국 시장 + 바이브코더 온보딩 |
| 온보딩 요구 | "한 줄 계측" 초간편(무침습) | 바이브코더 대상 채택성 |

### 라이선스 근거
- OpenTelemetry SDK/Collector: **Apache 2.0** — 수정·재배포·상업화 자유.
- ClickHouse: **Apache 2.0**.
- Grafana(AGPLv3)는 UI로 쓰지 않음 → UI 자체 구현으로 회피.
- SignOz는 **코드 복붙 금지, 아키텍처 레퍼런스로만** 참조(`ee/`는 별도 상용 라이선스).
- 상용 도구(와탭 등)는 폐쇄형 — **기능 개념/UX만 참조**, 코드·에셋·상표 미사용.

## 2. 로드맵 (기능은 넷 다, 순서로 자름)

같은 파이프라인 등뼈에 신호를 얹는 순서:

1. **[첫 스펙] 분산 트레이싱 등뼈** — 트랜잭션 리스트·레코드요약·트리뷰·SQL/HTTP 요약·서비스맵·RED
2. 실시간 X-View (제니퍼식 스캐터, WebSocket 라이브 스트림)
3. 애플리케이션/인프라 메트릭 (JVM·GC·힙·호스트)
4. 로그 수집/검색 (trace_id 상관)

이후: 알림 엔진 · tail 샘플링 · 프로파일링(액티브 스택/메소드 요약) · RUM · SSO/RBAC ·
멀티리전 · 과금.

### 와탭 주요 기능 → Phase 매핑 (레퍼런스 스크린샷 기반)

메인 대시보드/드릴다운 화면을 우리 파이프라인에 매핑한 것. 전부 Phase 1 트레이싱 등뼈 위에 얹힌다.

| 와탭 화면 | 데이터 원천 | Phase |
|---|---|---|
| 액티브 트랜잭션 스피드 (실시간 흐름, RPS/TPS) | 진행 중 트레이스(활성 스팬) 라이브 스트림 | 2 (X-View, WS) |
| 액티브 스테이터스 (METHOD/SQL/HTTPC/DBC/SOCKET 정체) | 활성 스팬의 현재 kind/상태 | 2 |
| 액티브 트랜잭션 도넛 (Very Slow/Slow/Normal) | 활성 트레이스 소요시간 임계 분류 | 2 |
| 히트맵 (응답시간 0~5s scatter, 에러 강조) | trace_summary(duration, error) | 2 |
| Apdex 점수 | RED duration + 임계 T (satisfied/tolerating) | 2 |
| TPS · 평균 응답시간 | red_rollup | 2 |
| 금일 TPS/사용자 (어제 대비 비교) | red_rollup + 시간대 시프트 비교 | 2 |
| 시스템 CPU | 호스트/런타임 메트릭 | 3 |
| 힙 메모리 (GC 톱니) | JVM 런타임 메트릭 | 3 |
| 동시접속 사용자 | RUM/세션 메트릭 (경량판은 활성세션 추정) | 3~로드맵 |
| 테이블 뷰 (SQL 단계별: 시간·갭·경과·내용·결과건수) | spans(db client, db_statement) + 파생 gap | 1 데이터 / 2 렌더 |
| 트리 뷰 (워터폴) | spans(부모-자식) | 1 |
| SQL 요약 / HTTP Call 요약 | spans(db/http client) | 2 |
| 트랜잭션 로그 (oname·수집시간 상관) | 로그 신호 + trace_id 상관 | 4 (로드맵 ④) |

**데이터 모델 보강 필요(위 화면에서 도출):**
- `spans`에 DB 결과건수 캡처: span_attrs의 `db.response.returned_rows`(OTel semconv) → 테이블 뷰 `[결과 건수]`.
- 테이블 뷰 "갭(gap)"은 형제/부모 스팬 간 시간차로 쿼리 시 파생(저장 불필요).
- `trace_summary`에 Apdex 분류용 파생은 red_rollup의 duration으로 계산(별도 컬럼 불필요).

## 3. 아키텍처

```
[앱]  Java(javaagent) / Node(SDK)  +  얇은 커스텀 distro
  │        OTLP/gRPC · OTLP/HTTP   (테넌트 API key 헤더)
  ▼
[1] Ingest Gateway (Go)
     · 인증(테넌트 식별)  · 스키마 검증  · tenant_id 태깅
     · enrich(GeoIP·User-Agent)  · 유량제어  · head 샘플링 훅
  │  produce (key = trace_id)
  ▼
[2] Kafka  topic: otlp.spans     ← BufferPort 인터페이스 (dev: 직결 bypass)
  │  consume (at-least-once)
  ▼
[3] ClickHouse Writer (Go)
     · 배치 삽입  · OTLP→행 매핑  · 재시도 + DLQ
  ▼
[4] ClickHouse   spans(원본) + trace_summary·red_rollup·service_edges(MV 파생)
  ▲  SQL
[5] Query Service (Go, 읽기전용)   트랜잭션·트레이스·서비스맵·RED API
  ▲  HTTP/JSON
[6] Web UI (React/TS)   트레이스분석·서비스맵·RED 대시보드
```

### 컴포넌트 경계
| 컴포넌트 | 하는 일 | 의존 | 언어 |
|---|---|---|---|
| Ingest Gateway | OTLP 수신·인증·enrich·태깅·검증 | Kafka(BufferPort), Postgres | Go |
| Writer | Kafka→ClickHouse 배치적재 | Kafka, ClickHouse | Go |
| Query Service | SQL→API (읽기전용) | ClickHouse, 인증 | Go |
| Web UI | 시각화 | Query API | React/TS |
| 커스텀 distro | 앱 계측 초간편화 | OTel SDK | Java, Node |
| Control-plane | 테넌트·키·유저 | Postgres | Go |

## 4. 데이터 모델 (ClickHouse)

원본/파생 분리: 드릴다운은 `spans`, 리스트/대시보드는 MV 파생 테이블.

### 4.1 `spans` (원본, 스팬당 1행)
```
tenant_id            LowCardinality(String)
trace_id             String            -- hex
span_id / parent_span_id   String
service_name         LowCardinality(String)   -- 와탭 oname
service_instance_id  LowCardinality(String)   -- oid
span_name            String
span_kind            Enum('SERVER','CLIENT','INTERNAL','PRODUCER','CONSUMER')
start_time           DateTime64(9)
duration_ns          UInt64
status_code          Enum('UNSET','OK','ERROR')
http_method LowCardinality, http_route, http_url, http_status_code UInt16
db_system LowCardinality, db_statement String, db_name
resource_attrs       Map(LowCardinality(String), String)   -- host/os/sdk
span_attrs           Map(LowCardinality(String), String)
events               Nested(name String, time DateTime64(9), attrs Map(...))
ENGINE = MergeTree
PARTITION BY (tenant_id, toDate(start_time))
ORDER BY (tenant_id, service_name, start_time)
INDEX idx_trace trace_id TYPE bloom_filter GRANULARITY 4
TTL toDateTime(start_time) + INTERVAL 15 DAY
```

### 4.2 `trace_summary` (트레이스=트랜잭션당 1행) — 와탭 "레코드 요약"
`spans` → MV → **AggregatingMergeTree**, key `(tenant_id, trace_id)`. 늦게 오는 스팬도 병합.
```
entry_service    = anyIf(service_name, kind='SERVER')      -- oname
transaction_name = anyIf(http_route, kind='SERVER')
start = minState, end = maxState(start+dur), duration        -- 경과시간
span_count, error_count = countIf(status='ERROR')
sql_count/sql_time_ns          = kind='CLIENT' AND db_system!=''
http_call_count/http_call_time = kind='CLIENT' AND http…
db_connection_time_ns, cpu_time_ns, mem_alloc_bytes = anyIf(runtime attrs, SERVER)
client_ip, geo_country, geo_city, user_agent, os, browser, client_type  -- SERVER enrich
```
→ 트랜잭션 리스트 + 레코드요약이 이 테이블 한 방 조회.

### 4.3 `red_rollup` (서비스별 RED, 분 단위)
MV → key `(tenant_id, service_name, toStartOfMinute(start_time))`:
`request_count`, `error_count`, `quantileState(duration)`(p50/p95/p99).

### 4.4 `service_edges` (서비스맵)
MV → 부모서비스→자식서비스 간선 `(tenant_id, from_service, to_service, minute)`:
`call_count`, `error_count`, latency state.

### 설계 포인트
- 파생은 전부 **MV로 쓰기 시점 자동 집계** → 쿼리 서비스는 단순 SELECT.
- "트레이스 완료 시점"을 몰라도 됨(AggregatingMergeTree가 늦은 스팬 병합).
- enrichment(지오·UA)는 게이트웨이에서 SERVER 스팬 속성으로 주입 → summary가 흡수.
- 프로파일링(액티브 스택/메소드 요약)은 표준 OTel 약점 → **로드맵**. 1차는 SQL/HTTP 스팬·트리뷰까지.

## 5. 인입 파이프라인 (C안 상세)

### Ingest Gateway (Go)
1. **OTLP 수신**: gRPC(:4317) + HTTP(:4318), 표준 protobuf → 모든 OTel SDK 무설정 호환.
2. **인증(테넌트 경계)**: 헤더 API key → Postgres control-plane 조회(LRU+TTL 캐시).
   미등록 = 401. 모든 스팬에 `tenant_id` 강제 주입(위조 불가).
3. **Enrichment**: 루트 SERVER 스팬에 GeoIP(MaxMind GeoLite2) + UA 파싱 →
   geo/os/browser/client_type 속성.
4. **샘플링 훅**: `Sampler` 인터페이스, 1차 기본 = 전량 보존.

### BufferPort (Kafka 추상화)
```go
type BufferPort interface {
    Publish(ctx context.Context, tenantID string, spans []*Span) error
}
```
- KafkaBuffer(운영): topic `otlp.spans`, key=trace_id(파티션 지역성), idempotent producer.
- DirectBuffer(개발): Kafka 없이 Writer 인라인 호출 → 로컬 관통 테스트.

### Writer (Go)
- 컨슈머 그룹 소비 → 배치 적재(5,000행/1초 flush) → ClickHouse native insert.
- **at-least-once**: CH ack 후 오프셋 커밋. 재시도 중복은 트레이스 상세 조회 시
  `LIMIT 1 BY span_id`로 dedup(분석 테이블 중복 관용).
- **DLQ**: N회 실패 스팬 → `otlp.spans.dlq` + 알람 메트릭(유실 없이 격리).
- **백프레셔**: Kafka=버퍼. 만수 시 게이트웨이 OTLP `RESOURCE_EXHAUSTED`/429 → SDK 재시도.

### 운영급 장치(1차 포함)
- 자기 관측(dogfood): 게이트웨이·writer가 자기 OTel 메트릭 방출.
- Control-plane(Postgres): tenants, api_keys (후속 users/org/billing 자리).

### 로드맵(OUT)
tail 샘플링 · 멀티리전 produce · exactly-once · 재처리 파이프라인 (자리만 열어둠).

## 6. Query Service + API

읽기 전용(별도 CH read 계정). 엔드포인트는 화면과 1:1.

| 화면 | 엔드포인트 | 소스 |
|---|---|---|
| 트랜잭션 리스트 | `GET /api/v1/transactions` | trace_summary |
| 레코드 요약 | `GET /api/v1/transactions/{traceId}` | trace_summary |
| 트리 뷰/워터폴 | `GET /api/v1/traces/{traceId}/spans` | spans |
| SQL 요약 | `GET /api/v1/traces/{traceId}/sql` | spans(db client) |
| HTTP Call 요약 | `GET /api/v1/traces/{traceId}/httpcalls` | spans(http client) |
| 서비스 목록+RED | `GET /api/v1/services` | red_rollup |
| RED 시계열 | `GET /api/v1/services/{name}/red?from&to&step` | red_rollup(quantileMerge) |
| 서비스맵 | `GET /api/v1/servicemap?from&to` | service_edges + red_rollup |

리스트 필터: `from,to,service,status,minDuration,maxDuration,httpRoute,q`. **키셋 페이지네이션**
`(start_time, trace_id)` 커서.

### 설계 포인트 (운영급·보안)
- **테넌트 격리 = 서버측 강제**: `tenant_id`는 인증 컨텍스트에서만 주입, 클라이언트 파라미터 불허.
- **파라미터 바인딩**: 모든 사용자 입력은 ClickHouse 바인드 파라미터(문자열 결합 금지).
- **시간창 상한**으로 CH 보호.
- DTO 계약 고정(내부 컬럼 변경이 UI 미파급).
- 인증: UI 사용자 세션/JWT(테넌트 스코프). SSO 로드맵.

### 로드맵 씨앗
- ②X-View: `GET /api/v1/live/transactions` WebSocket 스트림 — 이음새만.

## 7. Web UI

React + TypeScript + Vite · TanStack Query · **ECharts**(맵+시계열) · 가상화 테이블 · 다크 고밀도.

### 첫 스펙 화면 (와탭 미러)
- **트레이스 분석(메인)**: 상단 필터바(기간·서비스·에러·소요시간·검색·**URL 복사** 딥링크),
  좌 트랜잭션 테이블(가상화·키셋), 우 상세 패널(탭: **레코드요약·트리뷰·SQL요약·HTTP Call요약**,
  액티브스택/메소드요약 = "곧 제공" 비활성).
- **서비스맵/토폴로지**: 노드-간선 그래프, RED 색상, 노드→트랜잭션 필터.
- **서비스 RED 대시보드**: 서비스별 Rate/Error/Duration(p50·p95·p99) 시계열.

### 설계 원칙
- **URL 주도 상태**(필터·선택 트레이스) → 공유 딥링크(와탭 "URL 복사" 재현).
- 가상화 + 키셋 로딩으로 대용량 즉답.
- 컴포넌트 경계: `FilterBar`·`TransactionTable`·`TraceDetailPanel`(→`RecordSummary`/
  `TraceTree`/`SqlSummary`/`HttpCallSummary`)·`ServiceMap`·`RedDashboard`.
- 인증 게이트: 로그인→테넌트 스코프.

## 8. 온보딩 (커스텀 distro) — "한 줄 계측"

표준 OTel 위 얇은 패키징(포크 아님, Apache2 유지).

**Java (무침습)**: `java -javaagent:apm-agent.jar -jar app.jar` (`APM_KEY`만).
distro = OTel javaagent + extension(엔드포인트 프리셋·테넌트키 헤더·service.name 기본·샘플링).

**Node**: `node --require @apm/node/register app.js` (`APM_KEY`만).
npm 패키지가 OTel Node SDK + http/express/pg/mysql 자동계측 등록.

**바이브코더 경로**: 온보딩 화면이 테넌트키 + 붙여넣기 명령 제공, 첫 스팬 감지 시 ✅ "설치 확인".

## 9. 멀티테넌시·인증·보존·배포

- **멀티테넌시**: 전 행 `tenant_id`(게이트웨이 주입)+쿼리 서버측 강제. 1차 = 공유 테이블 소프트 격리.
  로드맵: 테넌트별 DB/클러스터.
- **인증 2평면**: ①인입 = 테넌트 API key(머신) ②UI = 사용자 로그인(세션/JWT→테넌트 스코프).
- **보존**: ClickHouse TTL(1차 전역 15일). 로드맵: 테넌트별 티어.
- **Control-plane**: Postgres(tenants, api_keys, users).
- **배포**: docker-compose 원커맨드(clickhouse·kafka(redpanda)·postgres·gateway·writer·query·ui).
  **dev 프로파일 = DirectBuffer**(Kafka 생략). 서비스 무상태 → 수평확장(writer=파티션, query=LB).
  k8s/helm 로드맵. 자기 관측(dogfood) 기본.

## 10. 테스트 전략

- **단위**: OTLP→행 매핑, enrich(geo/UA), summary 집계, 쿼리빌더(테넌트강제·파라미터바인딩), 트리 조립.
- **통합**: 게이트웨이→ClickHouse→쿼리(testcontainers 임시 CH). OTLP 전송→API 트랜잭션 등장.
- **E2E 관통(수용조건)**: compose up + Java·Node 데모앱 → UI 트랜잭션·서비스맵·RED 표시.
- **보안**: 크로스테넌트 격리(A가 B 못 봄), 필터 SQL 인젝션 시도.
- 로드/소크 = 로드맵.

## 11. 수용 기준 (Definition of Done — 첫 스펙)

- Java·Node 데모 → 한 줄 distro 계측 → 스팬 흐름 → UI에 트랜잭션 리스트·레코드요약·트리뷰·
  SQL/HTTP 요약·서비스맵·RED 표시.
- 멀티테넌트 격리 검증(A↔B 조회 차단).
- `docker-compose up` 원커맨드 기동. 개발은 Kafka 없이(DirectBuffer) 동작.
- 게이트웨이·writer가 자기 OTel 메트릭 방출.

## 12. 리포지토리 구조

```
/gateway /writer /query   (Go)
/web                      (React/TS)
/distro/java /distro/node (OTel 패키징 + extension / npm)
/schema                   (ClickHouse DDL + 마이그레이션)
/deploy                   (docker-compose; k8s later)
/demo                     (Java·Node 샘플 앱)
/internal/otlp            (공용 OTLP 타입/모델)
/docs
```
