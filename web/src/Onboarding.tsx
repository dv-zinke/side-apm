import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchServices } from "./api";

const endpoint = `http://${(typeof window !== "undefined" && window.location.hostname) || "localhost"}:4318`;

type Lang = { id: string; label: string; snippet: (svc: string, ep: string) => string };

const LANGS: Lang[] = [
  {
    id: "node", label: "Node.js",
    snippet: (svc, ep) => `# 1) 자동계측 패키지 설치
npm i @opentelemetry/api @opentelemetry/auto-instrumentations-node

# 2) 이 두 줄만 앞에 붙여서 실행 (코드 수정 0)
OTEL_SERVICE_NAME=${svc} \\
OTEL_EXPORTER_OTLP_ENDPOINT=${ep} \\
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\
node --require @opentelemetry/auto-instrumentations-node/register your-app.js`,
  },
  {
    id: "next", label: "Next.js",
    snippet: (svc, ep) => `# 1) 설치
npm i @vercel/otel @opentelemetry/api

# 2) instrumentation.ts (프로젝트 루트)
import { registerOTel } from '@vercel/otel';
export function register() {
  registerOTel({ serviceName: '${svc}' });
}

# 3) .env.local
OTEL_EXPORTER_OTLP_ENDPOINT=${ep}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`,
  },
  {
    id: "python", label: "Python",
    snippet: (svc, ep) => `# 1) 설치 + 부트스트랩
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install

# 2) 실행 앞에 붙이기 (코드 수정 0)
OTEL_SERVICE_NAME=${svc} \\
OTEL_EXPORTER_OTLP_ENDPOINT=${ep} \\
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\
opentelemetry-instrument python your_app.py`,
  },
  {
    id: "curl", label: "빠른 테스트 (curl)",
    snippet: (svc, ep) => `# SDK 없이 이 한 줄로 첫 트레이스 보내기 (복사→붙여넣기)
curl -X POST ${ep}/v1/traces -H 'Content-Type: application/json' -d '{
  "resourceSpans":[{"resource":{"attributes":[
    {"key":"service.name","value":{"stringValue":"${svc}"}}]},
  "scopeSpans":[{"spans":[{
    "traceId":"5b8efff798038103d269b633813fc60c",
    "spanId":"eee19b7ec3c1b174","name":"GET /hello","kind":2,
    "startTimeUnixNano":"'$(date +%s)'000000000",
    "endTimeUnixNano":"'$(date +%s)'050000000"}]}]}]}'`,
  },
  {
    id: "ai", label: "AI 프롬프트",
    snippet: (svc, ep) => `내 앱에 OpenTelemetry 자동계측을 붙여줘.
- 트레이스를 OTLP/HTTP(protobuf)로 ${ep} 에 보내기
- service.name 은 "${svc}"
- 코드 변경은 최소로, 실행 커맨드/설정 위주로
Node면 auto-instrumentations-node, Python이면 opentelemetry-instrument, Next.js면 @vercel/otel 을 써줘.`,
  },
];

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn copy-btn"
      onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}
    >
      {done ? "복사됨 ✓" : "복사"}
    </button>
  );
}

export function Onboarding() {
  const [svc, setSvc] = useState("my-app");
  const [lang, setLang] = useState("node");
  const active = LANGS.find((l) => l.id === lang)!;
  const code = active.snippet(svc || "my-app", endpoint);

  // Live connection detection: poll the services list; when the app's name
  // shows up, the pipeline is proven end-to-end.
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices, refetchInterval: 3000 });
  const connected = !!svc && (services ?? []).includes(svc);

  return (
    <div className="content-scroll">
      <div className="onboard">
        <div className="onboard-head">
          <h2>앱 연결하기</h2>
          <p>OTLP만 붙이면 끝. 에이전트 설치·계정 없이 <b>두 줄</b>이면 트레이스가 흐릅니다.</p>
        </div>

        <div className="onboard-row">
          <label className="onboard-field">
            <span className="field-label">서비스 이름</span>
            <input className="input" value={svc} onChange={(e) => setSvc(e.target.value.trim())} placeholder="my-app" aria-label="서비스 이름" />
          </label>
          <label className="onboard-field">
            <span className="field-label">OTLP 엔드포인트</span>
            <div className="endpoint-box"><code>{endpoint}</code><CopyBtn text={endpoint} /></div>
          </label>
        </div>

        <div className="segmented" role="tablist" aria-label="언어">
          {LANGS.map((l) => (
            <button key={l.id} role="tab" aria-selected={lang === l.id} className="seg" onClick={() => setLang(l.id)}>{l.label}</button>
          ))}
        </div>

        <div className="code-block">
          <div className="code-head">
            <span className="code-lang">{active.label}</span>
            <CopyBtn text={code} />
          </div>
          <pre><code>{code}</code></pre>
        </div>

        <div className={`connect-status${connected ? " ok" : ""}`}>
          {connected ? (
            <><span className="live-dot" /><b>연결됨</b> — <code>{svc}</code> 의 트레이스를 수신 중이에요. 대시보드에서 확인하세요.</>
          ) : (
            <><span className="spin" aria-hidden /><b>{svc || "앱"}</b> 의 첫 트레이스를 기다리는 중… (앱을 실행하고 요청을 한 번 보내보세요)</>
          )}
        </div>

        <details className="onboard-tip">
          <summary>지금 바로 체험 — 데모 트래픽 켜기</summary>
          <div className="code-block"><pre><code>docker compose -f deploy/docker-compose.yml --profile sim up -d --build sim</code></pre></div>
          <p>8개 가상 서비스가 다양한 지연·에러로 트래픽을 만들어 대시보드·서비스맵·히트맵을 바로 채웁니다.</p>
        </details>
      </div>
    </div>
  );
}
