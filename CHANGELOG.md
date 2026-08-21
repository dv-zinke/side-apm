# 변경 이력 (CHANGELOG)

OTel + ClickHouse APM 제품의 패치 기록. **작업(기능/수정)을 마칠 때마다 여기에 한 항목씩 추가**한다.

## 기록 규칙
- 최신이 위로 오게 **날짜 역순**. 하루에 여러 작업이면 같은 날짜 블록 안에 항목 누적.
- 분류: **Added**(신규) · **Changed**(변경) · **Fixed**(수정) · **Docs** · **Infra/Schema**.
- 각 항목은 한 줄 요약 + 필요 시 근거(파일/엔드포인트) + 끝에 커밋 해시 `` `abc1234` ``.
- 스키마/마이그레이션 변경은 반드시 **Infra/Schema**로 남기고 라이브 적용 여부를 표기(파일은 새 볼륨 최초 기동 시에만 적용됨).
- 상세 설계·핸드오프는 `docs/superpowers/`에 두고 여기서는 링크만.

---

## 2026-08-22
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
