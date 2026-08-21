# 진행 기록 / 핸드오프 — 시간축 통합 + 경쟁 격차 3종 (2026-08-22)

이어서 작업할 사람을 위한 세션 요약. 무엇을·왜·어디에 만들었고, 무엇이 검증됐고,
다음에 무엇을 하면 되는지. 관련: [[02-competitive-positioning]] · [[01-ux-excellence]] ·
[[2026-08-13-apm-otel-clickhouse-design]]

## TL;DR
이번 세션은 두 갈래였다.
1. **시간축 통합** — 상대/절대 시간 선택기 + 계층형 보관 + 공유 URL을 5개 조회 뷰에 일관 적용.
2. **경쟁 격차 Top 3 해소** — 에러 추적 인박스, 애드혹 스팬 쿼리(NRQL류), 알림 통지 라우팅.

모든 UI는 `cdo-design-review` 통과(전부 CONDITIONAL→수정 반영), 백엔드는 라이브 검증 완료.
커밋 범위: `3dee64e`(온보딩)부터 `5485339`(알림 라우팅)까지.

---

## Part A — 시간축 통합 (조회 UX의 뼈대)

### A1. 통합 시간 선택기 `web/src/range.tsx`
- `TimeSel = {kind:"relative", id}` | `{kind:"absolute", fromISO, toISO}`.
- 프리셋 15분/1시간/6시간/24시간/7일/30일 + **사용자 지정**(커스텀 달력 + 시각 입력).
- `resolveSel(sel, nowMs)` → `{fromISO, toISO, live}`. **상대=라이브 자동갱신, 절대=고정 스냅샷**.
- `useTimeSel()` — `useState<TimeSel>` 드롭인. 마운트 시 URL에서 읽고 변경 시 `replaceParams`로 기록.
- 부속: `StreamStatus`(라이브/고정 배너), `ResolutionNote`(서버가 서빙한 해상도 캡션), 커스텀 `Calendar.tsx`(범위 선택·키보드 그리드·AA 대비).

### A2. 계층형 보관 (임의 과거 창을 조회 가능하게) — `schema/002_derived.sql`, `017_rollup_hourly.sql`
| 계층 | 테이블 | 보관 | 용도 |
|---|---|---|---|
| 트레이스 상세 | `apm.spans` | **30일** | 워터폴 드릴다운 |
| 트레이스 인덱스 | `apm.trace_summary` | **30일**(신규: event_date 파티션+TTL) | 트레이스 목록/검색 |
| 분 단위 지표 | `apm.red_rollup` | **180일** | 대시보드·RED·SLO |
| 시 단위 지표 | `apm.red_rollup_1h`(신규 MV) | **730일(24개월)** | 장기 추세 |

- ⚠️ `trace_summary`는 원래 date 파티션·TTL이 없어 **무제한 증가**하던 것 → `event_date SimpleAggregateFunction(min,Date)` + 일 파티션 + 30일 TTL로 교정(라이브 재생성·백필 완료).

### A3. 창 길이 기반 자동 라우팅 — `query/derived_api.go`
- `GET /api/v1/red` 이 창 길이를 보고 **분↔시 롤업 자동 선택** + 해상도 다운샘플(quantilesMerge로 백분위 정확 병합), `{resolution, from, to, series}` 반환.
- `GET /api/v1/meta/retention` — 보관 지평선(traceDays/minuteDays/hourDays) 단일 소스 → UI 경고("개별 트레이스는 N일 보관 초과").
- 라우팅 경계: ≤2h→1m, ≤12h→5m, ≤48h→15m, ≤14d→1h, ≤60d→6h, else 1d.

### A4. 공유 가능한 URL 상태 — `web/src/urlState.ts`, `web/src/App.tsx`
- 라우터 의존성 없음. `?view=` (뷰, pushState+popstate) + `?range=` | `?from=&to=` (시간, replaceState).
- 5개 뷰가 시간 파라미터를 **공유** → 뷰 전환 시 창 유지. 대시보드는 파라미터-free 기본값.
- 피커에 **🔗 공유** 버튼(현재 링크 복사). Explore는 `?q=`로 쿼리도 공유.

### A5. 적용된 조회 뷰 (5개, 일관)
대시보드 · RED · **로그**(라이브 tail↔고정) · **데이터베이스**(쿼리집계+N+1) · **SLO**.
- 로그·DB 백엔드는 이미 `resolveWindow`로 from/to 지원했으나 UI가 안 보내던 것 → 연결만으로 활성화.
- SLO는 `windowHours` 하위호환 유지하며 from/to 수용.

---

## Part B — 경쟁 격차 Top 3 (검증기 `apm-feature-verifier` 진단 순)

### B1. 🥇 에러 추적 인박스 — `Errors.tsx`, `internal/storage/errors.go`, `query/errors_api.go`
DD Error Tracking / NR Errors Inbox 시그니처. **신규 스키마 0** — `apm.spans` 위 집계.
- 지문 = (service, operation, **errorType**). errorType 폴백: 정규화 메시지(숫자/UUID 마스킹) → error_name → `HTTP <status>`. → "socket hang up"·"read ECONNRESET"이 generic "Error"로 안 뭉침.
- `GET /api/v1/errors`(이슈 목록) + `/api/v1/errors/detail`(발생 추이 + 샘플 트레이스).
- UI: 이슈 테이블(서비스+작업 2줄) → 상세 모달(메시지·통계·**추이 막대차트 client zero-fill**·최근 트레이스) → 트레이스 워터폴.
- 네비 "에러 추적".

### B2. 🥈 애드혹 스팬 쿼리 (NRQL류) — `Explore.tsx`, `internal/storage/spanquery.go`, `query/spanquery_api.go`
DD Trace Query / NR NRQL. **안전한 제한 DSL** — 임의 SQL 노출 없음.
- 문법: `필드 연산자 값`을 AND로 연결. 필드 화이트리스트→고정 컬럼, `attr.*`/`res.*` 키는 정규식 검증 후 인라인, **모든 값은 파라미터 바인딩**. 조립 쿼리는 항상 tenant+window+LIMIT+`max_execution_time`.
- 필드: service·name·route·method·db·kind·status·httpstatus·duration·attr.*·res.* / 연산자 `= != > < >= <= ~ !~` / 시간 `1s·500ms·2m` / 상태 `error·ok`.
- **인젝션 거부 유닛테스트**: `internal/storage/spanquery_test.go`(DROP/UNION/따옴표 이스케이프 → QueryError).
- `GET /api/v1/spans/query` — 잘못된 DSL은 400+한글 메시지(인라인 표시), 그 외 실패는 별도 재시도 배너.
- UI: mono 쿼리바 + 예시 칩 + 문법 토글 + 결과 테이블 → 트레이스. 쿼리 `?q=` 공유.
- 네비 "탐색".

### B3. 🥉 알림 통지 라우팅 — `Alerts.tsx`, `internal/storage/channels.go`, `query/channels_api.go`, `query/alerts_eval.go`
"탐지는 되는데 사람에게 못 보내는" 마지막 1마일.
- 스키마(`schema/018_alert_channels.sql`): `alert_channels`(slack|webhook|pagerduty), `notifications`(발송 로그 30일), `alert_rules.channels`.
- 평가기 팬아웃: 발화 시 규칙 채널 해석 → **제공자별 포맷**(Slack `{text}` / PagerDuty Events v2 trigger·resolve+dedup_key / 범용 웹훅 JSON) → POST → 각 시도 성공/실패 로깅. 채널 미지정 → 환경 웹훅 폴백(하위호환). 이상탐지·합성 → 전체 채널 브로드캐스트. **디둡은 기존 발화-상태 전환으로 이미 처리**.
- API: `/api/v1/alert-channels` CRUD + `/{id}/test`(실전송+로깅), `/api/v1/notifications` 이력, 규칙 DTO에 channels[].
- UI: 알림 뷰 3탭(**규칙**: 채널 다중선택 / **채널**: 추가·테스트·삭제 / **발송 기록**: 성공·실패·에러).

---

## 검증 상태
- Go: `go test ./query/ ./internal/storage/` 그린. 파서 인젝션 테스트 포함.
- 프론트: `cd web && npm run build`(tsc -b + vite) 클린. 각 뷰 `cdo-design-review` 통과.
- 라이브: `/api/v1/red` 라우팅(1h→1m … 30d→6h), 절대 과거창, 에러 그룹 16개, 스팬쿼리 정상+인젝션 거부, 채널 테스트 실전송(httpbin 성공/실패+기록) 모두 확인.

## 실행 / 재현
```bash
docker compose -f deploy/docker-compose.yml up -d --build   # UI :3000 · Query :8080 · OTLP :4318
# 로그인 admin/admin. 재배포는 리포 루트에서(‑f 경로 주의). 브라우즈 캐시버스트 ?v=$(date +%s)
```
데모 트래픽 안 늘면 exporter 죽은 것 → `lsof -tiTCP:3001 | xargs kill -9` 후 재시작.
스키마 파일(`deploy/init/`)은 **새 볼륨 최초 기동 시에만** 적용 → 기존 볼륨엔 수동 마이그레이션 필요(이번 세션은 라이브 적용 완료).

## 남은 후보 (다음 쐐기)
- **에러 인박스 심화**: 이슈 상태(resolved/ignored) 토글 + 담당자, 첫 배포 상관(regression), 이슈→알림 규칙 원클릭.
- **스팬 쿼리 심화**: OR/괄호, `| stats count by <field>`(집계), 결과 타임시리즈 토글, 저장된 쿼리.
- **알림 라우팅 심화**: 재알림(renotify) 주기, 소음 억제 스케줄(정비창), 컴포지트 규칙, 채널별 심각도 필터.
- **검증기 재진단**: `apm-feature-verifier`로 새 Top 격차(예: 트레이스 샘플링/보존정책 UI, 800+ 통합, 소스맵 심볼리케이션) 도출.
- **횡단**: 이상탐지(`windowMin`)를 통합 피커로 통일(현재 미적용), 시각 입력 커스텀 스테퍼(native `<input type=time>` 잔존).
