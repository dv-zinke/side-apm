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
    OTEL_LOGS_EXPORTER: "none",
    OTEL_BSP_SCHEDULE_DELAY: "500",
    SVC_NAME: s.name,
    SVC_PORT: String(s.port),
    SVC_DEPS: (s.deps || []).map((n) => { const d = byName[n]; return `localhost:${d.port}/${(d.routes || ["work"])[0]}`; }).join(","),
    SVC_BASE: String(s.base),
    SVC_JITTER: String(s.jitter),
    SVC_SPIKE: String(s.spike || 0),
    SVC_ERR: String(s.err || 0),
    SVC_ROUTES: (s.routes || ["work"]).join(","),
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
