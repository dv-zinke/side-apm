import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchServices } from "./api";
import { useAuth } from "./auth";
import { useNav } from "./nav";

const endpoint = `http://${(typeof window !== "undefined" && window.location.hostname) || "localhost"}:4318`;

type Lang = { id: string; label: string; snippet: (svc: string, ep: string, tenant: string) => string };

// The tenant-routing header — only shown when the logged-in tenant isn't the
// default, so single-tenant users get the shortest possible snippet.
const mt = (t: string) => t && t !== "default";
const envHdr = (t: string) => (mt(t) ? `\nOTEL_EXPORTER_OTLP_HEADERS=x-apm-tenant=${t} \\` : "");

const LANGS: Lang[] = [
  {
    id: "node", label: "Node.js",
    snippet: (svc, ep, t) => `# 1) 자동계측 패키지 설치 (코드 수정 0)
npm i @opentelemetry/api @opentelemetry/auto-instrumentations-node

# 2) 실행 앞에 이 줄만 붙이면 끝
OTEL_SERVICE_NAME=${svc} \\
OTEL_EXPORTER_OTLP_ENDPOINT=${ep} \\
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\${envHdr(t)}
node --require @opentelemetry/auto-instrumentations-node/register your-app.js`,
  },
  {
    id: "next", label: "Next.js",
    snippet: (svc, ep, t) => `# 1) 설치
npm i @vercel/otel @opentelemetry/api

# 2) instrumentation.ts (프로젝트 루트)
import { registerOTel } from '@vercel/otel';
export function register() {
  registerOTel({ serviceName: '${svc}' });
}

# 3) .env.local
OTEL_EXPORTER_OTLP_ENDPOINT=${ep}
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf${mt(t) ? `\nOTEL_EXPORTER_OTLP_HEADERS=x-apm-tenant=${t}` : ""}`,
  },
  {
    id: "python", label: "Python",
    snippet: (svc, ep, t) => `# 1) 설치 + 부트스트랩
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install

# 2) 실행 앞에 붙이기 (코드 수정 0)
OTEL_SERVICE_NAME=${svc} \\
OTEL_EXPORTER_OTLP_ENDPOINT=${ep} \\
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\${envHdr(t)}
opentelemetry-instrument python your_app.py`,
  },
  {
    id: "go", label: "Go",
    snippet: (svc, ep, t) => `// go get go.opentelemetry.io/otel go.opentelemetry.io/otel/sdk \\
//   go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp \\
//   go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp
exp, _ := otlptracehttp.New(ctx,
  otlptracehttp.WithEndpoint("${ep.replace(/^https?:\/\//, "")}"), otlptracehttp.WithInsecure(),${mt(t) ? `\n  otlptracehttp.WithHeaders(map[string]string{"x-apm-tenant": "${t}"}),` : ""})
res, _ := resource.New(ctx, resource.WithAttributes(semconv.ServiceName("${svc}")))
otel.SetTracerProvider(sdktrace.NewTracerProvider(
  sdktrace.WithBatcher(exp), sdktrace.WithResource(res)))
// 그다음 핸들러만 감싸면 끝: otelhttp.NewHandler(mux, "server")`,
  },
  {
    id: "java", label: "Java",
    snippet: (svc, ep, t) => `# 1) OTel javaagent 내려받기
curl -L -o otel.jar https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar

# 2) -javaagent 한 줄 (코드 수정 0)
OTEL_SERVICE_NAME=${svc} \\
OTEL_EXPORTER_OTLP_ENDPOINT=${ep} \\
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \\${envHdr(t)}
java -javaagent:otel.jar -jar your-app.jar`,
  },
  {
    id: "curl", label: "빠른 테스트 (curl)",
    snippet: (svc, ep, t) => `# SDK 없이 이 한 줄로 첫 트레이스 보내기 (복사→붙여넣기)
curl -X POST ${ep}/v1/traces -H 'Content-Type: application/json' \\${mt(t) ? `\n  -H 'x-apm-tenant: ${t}' \\` : ""}
  -d '{"resourceSpans":[{"resource":{"attributes":[
    {"key":"service.name","value":{"stringValue":"${svc}"}}]},
  "scopeSpans":[{"spans":[{
    "traceId":"5b8efff798038103d269b633813fc60c",
    "spanId":"eee19b7ec3c1b174","name":"GET /hello","kind":2,
    "startTimeUnixNano":"'$(date +%s)'000000000",
    "endTimeUnixNano":"'$(date +%s)'050000000"}]}]}]}'`,
  },
  {
    id: "ai", label: "AI 프롬프트 ✨",
    snippet: (svc, ep, t) => `내 앱에 OpenTelemetry 자동계측을 붙여서 APM에 연결해줘.

목표:
- 트레이스·메트릭·로그를 OTLP/HTTP(protobuf)로 ${ep} 에 전송
- service.name = "${svc}"${mt(t) ? `\n- 모든 export 에 헤더 x-apm-tenant=${t} 추가 (테넌트 라우팅)` : ""}
- 코드 변경은 최소로, 실행 커맨드·env 설정 위주로

언어별 방법:
- Node: @opentelemetry/auto-instrumentations-node 설치 후 node --require 로 로드
- Python: opentelemetry-distro + opentelemetry-instrument
- Next.js: @vercel/otel 의 registerOTel
- Java: opentelemetry-javaagent.jar 를 -javaagent 로 로드
- Go: otlptracehttp 익스포터 + otelhttp 미들웨어

완료되면 실행 명령을 알려주고, 요청을 한 번 보내 트레이스가 흐르는지 확인해줘.`,
  },
];

function CopyBtn({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      setState("fail");
    }
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <>
      <button className="btn copy-btn" onClick={copy}>
        {state === "done" ? "복사됨 ✓" : state === "fail" ? "복사 실패" : "복사"}
      </button>
      {state === "fail" && <span className="copy-fail" role="alert">코드를 직접 선택해 복사하세요</span>}
    </>
  );
}

export function Onboarding() {
  const { auth } = useAuth();
  const { openService } = useNav();
  const tenant = auth?.tenant || "default";
  const [svc, setSvc] = useState("my-app");
  const [lang, setLang] = useState("node");
  const active = LANGS.find((l) => l.id === lang)!;
  const code = active.snippet(svc || "my-app", endpoint, tenant);

  // Live connection detection: poll the (tenant-scoped) services list; when the
  // app's name shows up, the pipeline is proven end-to-end for this tenant.
  const { data: services, isError } = useQuery({ queryKey: ["services"], queryFn: fetchServices, refetchInterval: 3000 });
  const connected = !!svc && (services ?? []).includes(svc);

  return (
    <div className="content-scroll">
      <div className="onboard">
        <div className="onboard-head">
          <h2>앱 연결하기 <span className="onboard-min">1분 컷</span></h2>
          <p>OTLP만 붙이면 끝. 에이전트 설치·SDK 코드 없이 <b>한 줄</b>이면 트레이스가 흐릅니다.
            {mt(tenant) && <> 데이터는 <code>{tenant}</code> 테넌트로 라우팅돼요.</>}</p>
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
          {mt(tenant) && (
            <label className="onboard-field">
              <span className="field-label">테넌트 헤더</span>
              <div className="endpoint-box"><code>x-apm-tenant: {tenant}</code><CopyBtn text={`x-apm-tenant: ${tenant}`} /></div>
            </label>
          )}
        </div>

        <div className="segmented" role="tablist" aria-label="언어" style={{ flexWrap: "wrap" }}>
          {LANGS.map((l) => (
            <button key={l.id} role="tab" aria-selected={lang === l.id} className="seg" onClick={() => setLang(l.id)}>{l.label}</button>
          ))}
        </div>

        <div className="code-block">
          <div className="code-head">
            <span className="code-lang">{active.label}</span>
            <CopyBtn text={code} />
          </div>
          <pre tabIndex={0} aria-label={`${active.label} 연결 스니펫 — 가로 스크롤로 전체 보기`}><code>{code}</code></pre>
        </div>

        <div className={`connect-status${connected ? " ok" : isError ? " err" : ""}`} aria-live="polite">
          {connected ? (
            <>
              <span className="live-dot" /><b>연결됨</b> — <code>{svc}</code> 의 트레이스를 수신 중이에요.
              <button className="btn btn-primary btn-sm" style={{ marginLeft: "auto" }} onClick={() => openService(svc)}>트레이스 보기 →</button>
            </>
          ) : isError ? (
            <>⚠ 연결 상태를 확인하지 못했어요 — 네트워크를 확인하고 새로고침해주세요.</>
          ) : (
            <><span className="spin" aria-hidden /><b>{svc || "앱"}</b> 의 첫 트레이스를 기다리는 중… (앱을 실행하고 요청을 한 번 보내보세요)</>
          )}
        </div>

        <details className="onboard-tip">
          <summary>지금 바로 체험 — 실제 예제 앱 켜기</summary>
          <div className="code-block"><pre><code>docker compose -f deploy/docker-compose.yml --profile realapp up -d --build realapp</code></pre></div>
          <p>실제 Node 앱(shop-web)이 외부 API를 호출하며 진짜 트레이스를 만들어요. 8개 가상 서비스가 필요하면 <code>--profile sim</code>.</p>
        </details>
      </div>
    </div>
  );
}
