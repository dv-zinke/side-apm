# APM 프로젝트 규칙

OpenTelemetry + ClickHouse 기반 APM(모니터링) 제품. Go 백엔드(gateway/query) + React 웹(`web/`, `localhost:3000`).

## 디자인·UX 기준 (모든 UI Task에 적용)

모든 UI/프론트엔드 작업(`web/` 하위 컴포넌트·스타일·인터랙션 생성·수정)에는 아래 두 기준을 **반드시** 적용한다.

### 디자인 — pbakaus/impeccable 수준
- UI Task 실행 시 **`impeccable:impeccable` 스킬을 사용**한다.
- 군더더기 없는 시각 위계, 의도된 여백, 일관된 타이포 스케일, 살아있는 마이크로 인터랙션. AI slop(밋밋한 기본값) 배격.

### UX — `docs/superpowers/specs/01-ux-excellence.md` 필수 준수
이 문서가 UX 헌법이다. 특히 다음을 지킨다:
- **12상태 체크리스트** (§14.1): Default·Hover·Focus·Active·Disabled·Loading·Error·Success·Empty·Overflow·Offline·Mobile — 처음부터 구현.
- **보이스 가이드 / 금지어** (§6): "처리 중입니다", "오류가 발생했습니다", "잠시만 기다려주세요" 등 금지어 0건. 버튼은 동사, 에러는 문제+해결 세트.
- **AI(데이터) 투명성** (§7): 실제 진행 상태를 실시간·정직하게 표시. 가짜 단계 금지. 수치는 단위·맥락과 함께.
- **50ms 반응** (§4, §13): 모든 액션은 50ms 이내 시각적 반응. 로딩 3등급·스켈레톤 규칙 준수.
- **접근성 AA** (§8): WCAG 2.1 AA — 본문 대비 4.5:1, 키보드 완주, 포커스 링, aria, 모바일 44px 터치, `prefers-reduced-motion` 존중.

### 검토
- UI 단계가 끝나면 **`cdo-design-review` 에이전트**(`.claude/agents/cdo-design-review.md`)로 실제 화면을 검토한다. "CDO 검토" / "디자인 검토"로 트리거.

## 참고 문서
- `docs/superpowers/specs/2026-08-13-apm-otel-clickhouse-design.md` — 아키텍처/스키마 설계 + Known limitations
- `docs/superpowers/specs/2026-08-13-apm-feature-catalog.md` — 기능 카탈로그 + Phase 매핑
- `docs/superpowers/plans/` — Phase별 구현 계획

## 로컬 실행 / 데모
```bash
docker compose -f deploy/docker-compose.yml up -d --build   # UI :3000 · Query :8080 · OTLP :4318
```
데모 트래픽(`demo/node`)이 응답은 하는데 데이터가 안 늘면 exporter가 죽은 것 → `lsof -tiTCP:3001 | xargs kill -9` 후 재시작.
