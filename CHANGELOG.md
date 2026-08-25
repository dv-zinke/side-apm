# 변경 이력 (CHANGELOG)

OTel + ClickHouse APM 제품의 패치 기록. **작업(기능/수정)을 마칠 때마다 여기에 한 항목씩 추가**한다.

## 기록 규칙
- 최신이 위로 오게 **날짜 역순**. 하루에 여러 작업이면 같은 날짜 블록 안에 항목 누적.
- 분류: **Added**(신규) · **Changed**(변경) · **Fixed**(수정) · **Docs** · **Infra/Schema**.
- 각 항목은 한 줄 요약 + 필요 시 근거(파일/엔드포인트) + 끝에 커밋 해시 `` `abc1234` ``.
- 스키마/마이그레이션 변경은 반드시 **Infra/Schema**로 남기고 라이브 적용 여부를 표기(파일은 새 볼륨 최초 기동 시에만 적용됨).
- 상세 설계·핸드오프는 `docs/superpowers/`에 두고 여기서는 링크만.

---

## 2026-08-25
### Added
- **테일 기반 샘플링 / 트레이스 인입 제어** (검증기 1위 격차, D2 비용 서사 방어) — 게이트웨이 인입 엣지에서 서비스별 보관 비율 규칙 적용. **에러·느린 스팬(>1초)은 항상 보관**(문제 안 놓침), 나머지는 traceId 해시 기반 확률 보관(트레이스 일관). 규칙 없으면 전량 보관(안전 기본). 규칙은 CH에서 백그라운드 폴링(핫패스 무DB), 인입량은 `ingest_stats`로 주기 flush. 스키마 `sampling_rules`·`ingest_stats`(라이브). `internal/sampling/sampler.go`가 `buffer.Port` 래핑. `/api/v1/ingest/sampling` CRUD + `/ingest/stats`. 신규 뷰 "인입 제어"(보관비율 슬라이더·규칙표·수신/보관/절감 KPI·인입량 스택차트). 검증: 20% 규칙 → 실측 드롭 46.6%(우선보관으로 설정보다 높은 보관율, 정직). CDO 수정: 삭제 undo·통계 로딩스켈레톤/에러상태(가짜 0% 제거)·슬라이더 포커스·aria-live. `cmd/gateway/main.go`·`web/src/Ingest.tsx`.
### Changed
- **통합 시간 피커 완성도 sweep** — 시간 창 컨트롤이 없던 서비스맵·RUM·모바일 앱에 `TimeRangePicker` 적용(백엔드는 이미 from/to 지원, 프론트만). 상대=라이브/절대=고정·URL 공유·keepPreviousData. 각 뷰의 서브카드(RUM 클릭·에러·리소스·리플레이, 앱 화면·크래시·네트워크)가 선택 창 기준 갱신. CDO 수정: 서비스맵 pane-head가 랩톱 폭(≤1180px)에서 범례+피커 경쟁으로 깨지던 것 → 피커를 자기 행으로 wrap + 범례 nowrap. `web/src/{ServiceMap,Rum,Apps}.tsx`·api.ts.
- **배포 카드 → RED 드릴다운** — 배포 추적 카드 클릭 시 해당 서비스 RED 차트로 이동(배포 마커 오버레이). RED가 `?redsvc=` 딥링크로 초기 서비스 수용(서비스 select도 URL 반영). 카드 hover-lift·focus 링·키보드(Enter), 배포 시각을 hover title→인라인 노출(모바일 접근). 리뷰어 비차단 지적 반영. `web/src/Deploys.tsx`·`web/src/RedDashboard.tsx`.
### Added
- **배포 추적/회귀 감지 뷰** — Datadog Deployment / NR Change Tracking 대응. 각 배포 마커 전후 ±N분(15/30/60)의 서비스 RED(에러율·p95)를 before→after 비교, 판정(회귀 의심 ▲/개선 ▼/변화 없음 ＝) + 회귀 카운트. 기존 deploys 테이블·red_rollup 재사용, 신규 스키마 0. `GET /api/v1/deploys/impact`, 네비 "배포 추적". CDO 수정(FAIL→): 화살표를 판정과 동기화(동일 수치 모순 제거), 배지 색+기호 병행, 에러/빈 상태·radiogroup. `internal/storage/deploys.go`·`query/deploy_api.go`·`web/src/Deploys.tsx`.
- **알림 규칙 무음(snooze/정비창)** — 규칙별 알림을 30분/1시간/4시간/내일까지 일시 무음(정비 중 스팸 방지). 비활성(평가 정지)과 달리 **평가·발화 이력은 계속, 채널 발송만 억제**. 무음 중 규칙은 amber 좌측 레일 + "🔕 약 N시간 · 해제". 스키마 `alert_rules.snooze_until`(라이브). 평가기 fire()가 snooze 시 발화 기록 후 dispatch 스킵. 기존 upsert 경로 재사용(신규 엔드포인트 0). CDO 수정: 메뉴 바깥클릭·Esc·화살표키·포커스·모바일 44px·카드 셀 라벨(data-label)·무음 실패 인라인. `internal/storage/alerts.go`·`query/alerts_eval.go`·`web/src/Alerts.tsx`.

## 2026-08-22
### Added
- **알림 규칙 조건 확장** — 기존 error_rate·p95_ms에 **error_count(절대 에러 건수)** + **log_match(로그 쿼리 매칭 건수)** 추가. log_match는 방금 만든 로그 DSL을 재사용(`CountLogMatches`)해 "최근 N분간 `severity=error AND body~"OOM"` 매칭 > M건이면 발화". 평가기·채널 라우팅·발화영속화 전부 재사용. 스키마: `alert_rules.query` 컬럼 추가(라이브). 룰 폼: 지표 4종·log_match 시 서비스→쿼리 필드 스왑·조건 요약 프리뷰. CDO 수정: 필드별 에러(aria-invalid+포커스)·aria-live·submit 언블록·프리뷰. 검증: log_match val=87·error_count val=33 발화. `internal/storage/alerts.go`·`query/alerts_eval.go`·`web/src/Alerts.tsx`.
- **로그 검색·집계 (`/api/v1/logs/query`)** — 스팬 쿼리 안전 DSL을 로그 테이블에 이식(SigNoz/Loki 대응). 필드 필터(service·severity·body·trace·span·attr.*, `= != ~ !~`, severity 대소문자무시) + `| stats count,errors by …` 집계. 로그 뷰에 "검색" 모드(mono 쿼리바·예시칩·로그목록/패싯). `RunLogQuery` 목록/집계 분기, 파서 유닛테스트. FacetView 공유. CDO 수정: 모바일 로그행 2줄 리플로우·예시 count-first·쿼리 URL(`?logq=`)·isFetching. `internal/storage/logquery.go`·`query/logs_api.go`·`web/src/Logs.tsx`. 신규 스키마 0.
- **에러 인박스 이슈 상태 관리** — 이슈별 해결/무시/되돌리기 트리아지 + 상태 필터 탭(활성/해결됨/무시됨/전체) + **재발 자동 감지**(해결 후 다시 발생하면 "재발" 승격). 신규 `apm.error_status`(fingerprint별, ReplacingMergeTree). `POST /api/v1/errors/{fp}/status`, `GET /api/v1/errors?state=`. 상태 필터 URL 저장(`?state=`). CDO 수정: 버튼 pending 라벨·`.btn:disabled`, 배지 AA(`--ok/warn-strong`), aria-live. `internal/storage/errors.go`·`query/errors_api.go`·`web/src/Errors.tsx`.
- **Explore 집계(패싯) 쿼리** — 스팬 쿼리 DSL에 `… | stats <함수> by <필드>` 파이프 추가(NRQL FACET류). 함수 count·errors·avg·p50·p95·p99·max·min, 그룹 필드 화이트리스트(파이프 없이 `stats …`로 시작해도 동작). 안전성 유지(함수·필드 화이트리스트 + 값 파라미터 바인딩). UI: 집계 표(그룹 키 + 지표 열, 첫 지표에 비례 인라인 막대). 파서 유닛테스트 `TestParseStats`. `RunSpanQuery`가 목록/집계 분기. CDO 수정(모바일 카드 리플로우·막대 대비·열 폭·빈 집계 카피).
### Infra/Schema
- **ClickHouse 디스크 회수 27GB→9.6GB**. 원인 3종: (1) spans 원장 폭증(하루 2~4천만) — 3일 초과 파티션 즉시 DROP + 라이브 TTL 30d→3d(spans/logs/trace_summary), (2) 데모 과다 유입 — `SIM_RPS` 12→3(4배↓, compose 커밋), (3) **ClickHouse 시스템 로그 12.4GB**(text_log/query_log/trace_log 등) truncate + `deploy/clickhouse/system_logs.xml`로 2일 TTL 영구화(config 마운트 커밋).
  - ⚠️ 라이브 TTL(원장 3d)은 **로컬 DB에만** 적용. 커밋 스키마는 설계대로 30d 유지 → 새 볼륨 최초 기동 시 다시 30d. 로컬 재발 시 동일 ALTER(파티션 DROP + TTL 3d) 재적용.
### Docs
- 세션 핸드오프 문서 + 포지셔닝 트래커 갱신(에러 인박스·스팬 쿼리·알림 라우팅·계층형 보관을 shipped로) — `docs/.../2026-08-22-progress-time-and-competitive-gaps.md` · `60ee67d`
- `CHANGELOG.md` 신설(이 파일) — 매 작업 후 패치 기록 규칙 확립

## 2026-08-21
### Added
- **알림 통지 라우팅** (경쟁 격차 #3): 채널(Slack/Webhook/PagerDuty) CRUD + 규칙별 팬아웃 + 발송 로그. 제공자별 포맷(Slack `{text}`/PagerDuty Events v2/webhook JSON), 채널 미지정 시 환경 웹훅 폴백, 이상탐지·합성은 전체 브로드캐스트. 디둡은 발화-상태 전환으로 처리. `/api/v1/alert-channels`·`/api/v1/notifications`. 알림 뷰 3탭(규칙/채널/발송 기록). `5485339`
### Infra/Schema
- `schema/018_alert_channels.sql`: `alert_channels`·`notifications`(30d TTL)·`alert_rules.channels` — **라이브 적용 완료**.

## 2026-08-20
### Added
- **애드혹 스팬 쿼리 (NRQL류)** (경쟁 격차 #2): 안전 제한 DSL(`필드 연산자 값` AND 결합, 컬럼 화이트리스트 + attr 키 정규식 + 값 파라미터 바인딩 + 강제 LIMIT/타임아웃). 인젝션 거부 유닛테스트. `/api/v1/spans/query`, 네비 "탐색", 쿼리 `?q=` 공유. `9216400`
- **에러 추적 인박스** (경쟁 격차 #1): 에러 스팬→이슈 그룹(신규 스키마 0). 지문=service·operation·errorType(메시지 정규화 폴백). 추이 차트+샘플 트레이스 드릴다운. `/api/v1/errors`, 네비 "에러 추적". `4dd8bdc`
- **공유 가능한 URL 상태**: `?view=`(뷰)+`?range=`|`?from=&to=`(시간), 라우터 의존성 없음. 🔗 공유 버튼. 5개 뷰 시간창 공유. `web/src/urlState.ts`. `7c6e3bf`
- **SLO 뷰 통합 시간 피커** (5번째 조회 뷰). `windowHours` 하위호환 유지. `ba5827b`
- **로그·데이터베이스 시간 피커**: 백엔드는 이미 from/to 지원 → UI 연결. 로그는 라이브 tail↔고정 스냅샷. `fed22f8`

## 2026-08-19
### Added
- **절대 시간 선택 + 계층형 보관**: 상대/절대 시간 피커, 보관 30d(트레이스)/180d(분 지표)/24mo(시 지표), 창 길이 자동 라우팅(`/api/v1/red`), `/api/v1/meta/retention`. `02b7fc3`
- **커스텀 달력 UI**: native datetime 대체(범위 선택·키보드 그리드·AA 대비). `fd508a2`
- **타임스탬프 입력 간소화**: 빠른 칩(오늘·어제·최근 N)·"지금" 버튼·구간 길이 표시. `b2b605c`
- **대시보드·RED 시간 범위 피커**(상대 창). `7f8cfa7`
- **바이브코더 한 줄 온보딩** (D4): 멀티테넌트 인식·라이브 연결감지·AI 프롬프트. `3dee64e`
### Infra/Schema
- `trace_summary` date 파티션+30d TTL(무제한 증가 교정), `red_rollup` 180d TTL, `red_rollup_1h`(24mo) 신규 MV — **라이브 재생성·백필 완료**. `02b7fc3`

## 2026-08-18
### Added
- 대시보드 서비스 다중선택 토글(전체 표시·개별 on/off) `5b3ff4b`; 서비스 필터 + 서비스별 스택 처리량 `41ee7e0`.
- 배경 알림 평가기 멀티테넌트화 (P2-2) `2547bf2`.
- 실제 예제 앱(shop-web) — 시뮬레이션 아닌 진짜 OTel 데이터 `360c90a`.
- ClickHouse 쿼리 자체계측(otelsql) — 자기 트레이스에 실제 DB 스팬 `50955d7`.
### Fixed
- DBM 서비스 필터(P2-1) + SLO 예산 클램프(P3-1) `014948d`.
- SSE 인증 회귀 + health 유령 서비스 `41ee7e0`.
### Changed (perf)
- self-tracing으로 발견한 실제 병목 수정: SLO 단일 집계 쿼리 `235a153`, health/anomalies 단일 배치 쿼리(10-12x) `c5d020c`.
