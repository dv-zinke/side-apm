// Supervisor: spawns one instrumented process per topology node, then drives
// continuous traffic through the Gateway so full cross-service traces flow.
const { spawn } = require("child_process");
const http = require("http");
const { services, byName } = require("./topology");

const REGISTER = "@opentelemetry/auto-instrumentations-node/register";
const OTLP = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
const RPS = Number(process.env.SIM_RPS || 12);

const children = services.map((s) => {
  const env = {
    ...process.env,
    OTEL_SERVICE_NAME: s.name,
    OTEL_EXPORTER_OTLP_ENDPOINT: OTLP,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_METRIC_EXPORT_INTERVAL: "10000",
    OTEL_METRIC_EXPORT_TIMEOUT: "5000",
    // delta temporality so each export is that window's counts → summable for
    // server-side Apdex/percentiles from http.server.request.duration.
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "delta",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_BSP_SCHEDULE_DELAY: "500",
    SVC_NAME: s.name,
    SVC_PORT: String(s.port),
    SVC_DEPS: (s.deps || []).map((n) => { const d = byName[n]; return `localhost:${d.port}/${(d.routes || ["work"])[0]}`; }).join(","),
    SVC_BASE: String(s.base),
    SVC_JITTER: String(s.jitter),
    SVC_SPIKE: String(s.spike || 0),
    SVC_ERR: String(s.err || 0),
    SVC_ROUTES: (s.routes || ["work"]).join(","),
    SVC_QUERIES: (s.queries || []).join("|"),
  };
  return spawn("node", ["-r", REGISTER, "service.js"], { env, stdio: "inherit", cwd: __dirname });
});

function stop() { children.forEach((c) => c.kill("SIGTERM")); process.exit(0); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// Drive traffic through the Gateway once services have warmed up.
const gw = byName.GatewayService;
function hit() {
  const route = gw.routes[Math.floor(Math.random() * gw.routes.length)];
  const req = http.get(`http://localhost:${gw.port}/${route}`, (r) => { r.on("data", () => {}); r.on("end", () => {}); });
  req.on("error", () => {});
  req.setTimeout(10000, () => req.destroy());
}
setTimeout(() => {
  console.log(`[sim] driving ~${RPS} rps through ${gw.name} → ${OTLP}`);
  setInterval(hit, Math.max(20, Math.floor(1000 / RPS)));
}, 4000);

// Keep RUM alive: post browser-like sessions to the gateway on an interval so
// the RUM view has continuous data (the browser agent only fires on real use).
const RUM_PAGES = ["/dashboard", "/trace", "/rum", "/alerts", "/db", "/servicemap", "/infra"];
const RUM_CLICKS = ["대시보드", "트레이스 분석", "RED 대시보드", "알림", "서비스맵", "규칙 추가", "다크 모드로 전환", "복사", "저장하기", "에러만", "X-View", "연결하기", "컨테이너"];
const RUM_ERRORS = ["TypeError: Cannot read properties of undefined (reading 'map')", "NetworkError: Failed to fetch", "Unhandled: request timeout after 10000ms"];
const RUM_RES = ["/api/v1/transactions", "/api/v1/servicemap", "/api/v1/live/recent", "/api/v1/alerts", "/api/v1/db/queries", "/api/v1/rum/overview"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rint = (a, b) => a + Math.floor(Math.random() * (b - a));

function postJSON(path, body) {
  const data = JSON.stringify(body);
  const req = http.request(OTLP + path, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
    (r) => { r.on("data", () => {}); r.on("end", () => {}); });
  req.on("error", () => {});
  req.write(data); req.end();
}
function rumSession() {
  const now = Date.now();
  const page = pick(RUM_PAGES);
  const ev = [{ type: "pageview", ts: now, page }];
  for (let i = 0; i < rint(3, 12); i++) ev.push({ type: "click", ts: now, target: pick(RUM_CLICKS) });
  for (let i = 0; i < rint(2, 6); i++) ev.push({ type: "resource", ts: now, url: pick(RUM_RES), value: rint(15, 950), status: pick([200, 200, 200, 304, 500]) });
  ev.push({ type: "vital", ts: now, metric: "LCP", value: rint(700, 4300) });
  ev.push({ type: "vital", ts: now, metric: "INP", value: rint(20, 380) });
  ev.push({ type: "vital", ts: now, metric: "CLS", value: Math.round(Math.random() * 250) / 1000 });
  if (Math.random() < 0.28) ev.push({ type: "error", ts: now, message: pick(RUM_ERRORS), stack: "at App.tsx:42:11" });
  postJSON("/v1/rum", { sessionId: "sim" + rint(1, 1e9), page, ua: "Mozilla/5.0 (sim)", events: ev });
}
setTimeout(() => { console.log("[sim] seeding RUM sessions"); setInterval(rumSession, 1200); }, 6000);
