# RUM (실사용자 모니터링) — 기능 정리 + 구현 스코프

- 날짜: 2026-08-15
- 목적: 브라우저에서 실제 사용자 행동·성능·에러를 수집해 프론트엔드를 관측. DD/NR RUM 대비 오픈스택 버전.
- 연동: [[02-competitive-positioning]] §격차(RUM=DD/NR 우위)를 좁히는 기능.

## 수집 이벤트 (5종)

| 타입 | 무엇 | 소스 |
|---|---|---|
| **pageview** | 페이지 진입(경로·referrer·UA) | load / SPA route change |
| **click** | 클릭 요소(텍스트/셀렉터) → "많이 클릭한 것" | document click 캡처 |
| **error** | 프론트 에러(메시지·스택·URL) | window.onerror + unhandledrejection |
| **vital** | Core Web Vitals(LCP/CLS/INP/FCP/TTFB) | PerformanceObserver |
| **resource** | HTTP 요청(URL·상태·소요) → 프론트 HTTP | PerformanceObserver('resource') |

## 화면 (RUM 뷰)

1. **개요 KPI**: 세션 수, 페이지뷰, 프론트 에러 수, LCP p75
2. **인기 클릭** (많이 클릭한 것): target별 카운트 Top
3. **프론트 에러**: 메시지별 그룹핑 + 최근 발생·경로
4. **HTTP(리소스)**: URL별 호출·평균·상태
5. **성능**: 페이지별 LCP/CLS/INP p75

## 구현 (MVP — 이번 단계)

- **수집 스크립트** `web/public/rum.js`: 경량 바닐라, 배치 POST `/v1/rum`
- **게이트웨이** `/v1/rum`: JSON 수신 → 비동기 배처 → CH (traces와 동일 내구성)
- **스토리지** `apm.rum_events` + 집계(clicks/errors/resources/vitals/overview)
- **query API** `/api/v1/rum/*`, **web RUM 뷰**
- **데모**: 콘솔·데모 페이지에 스크립트 삽입 + seed

## 완료 (2026-08 업데이트)

- **세션 리플레이(에러 비디오)**: ✅ 구현. rum.js가 rrweb로 DOM을 녹화(마지막 full snapshot 이후 버퍼)하다 에러 시 `/v1/rum/replay`로 전송 → `apm.rum_replays`(7일 TTL). `/api/v1/rum/replays` 목록 + `/replays/{id}` 이벤트, rrweb-player 재생 모달. sim이 재생 가능한 소형 리플레이를 지속 생성.

## 로드맵 (후속)

- **소스맵 심볼리케이션**: 현재 프론트 에러 스택은 minified 상태. 소스맵 업로드 → 원본 위치 복원(DD/NR RUM 대비 격차).
- 사용자 여정/퍼널, 지오·디바이스 분해.
