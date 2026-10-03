// Generic instrumented service. One process per topology node; OTEL_SERVICE_NAME
// gives it its identity. Each route sleeps (latency profile), calls its
// downstream deps over HTTP (trace context auto-propagates), then maybe errors.
const express = require("express");
const http = require("http");
const pino = require("pino");
const { trace, SpanKind } = require("@opentelemetry/api");

const NAME = process.env.SVC_NAME || "svc";
const logger = pino({ name: NAME });
const tracer = trace.getTracer("sim-db");
const QUERIES = (process.env.SVC_QUERIES || "").split("|").filter(Boolean);
const PORT = Number(process.env.SVC_PORT || 3100);
const DEPS = (process.env.SVC_DEPS || "").split(",").filter(Boolean); // host:port list
const BASE = Number(process.env.SVC_BASE || 40);
const JITTER = Number(process.env.SVC_JITTER || 40);
const SPIKE = Number(process.env.SVC_SPIKE || 0);
const ERR = Number(process.env.SVC_ERR || 0);
const ROUTES = (process.env.SVC_ROUTES || "work").split(",").filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oneQuery(sql) {
  const op = sql.trim().split(/\s+/)[0].toUpperCase();
  const dbMs = 4 + Math.random() * 30 + (Math.random() < 0.06 ? 300 + Math.random() * 900 : 0);
  await tracer.startActiveSpan(`${op} appdb`, {
    kind: SpanKind.CLIENT,
    attributes: { "db.system": "postgresql", "db.name": "appdb", "db.statement": sql },
  }, async (span) => {
    await sleep(dbMs);
    span.end();
  });
}

// Emit child DB span(s) under the active request span. ~8% of requests exhibit
// an N+1 pattern (same SELECT looped per row) so N+1 detection has real data.
async function dbQuery() {
  if (QUERIES.length === 0) return;
  const sql = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  if (sql.startsWith("SELECT") && Math.random() < 0.08) {
    const n = 5 + Math.floor(Math.random() * 12); // N+1: 5–16 repeats
    for (let i = 0; i < n; i++) await oneQuery(sql);
    return;
  }
  await oneQuery(sql);
}
function latency() {
  let d = BASE + Math.random() * JITTER;
  if (Math.random() < SPIKE) d += 1500 + Math.random() * 2500; // very-slow stall
  return d;
}
function callDep(target) {
  // target already includes the callee's real route path (host:port/route)
  return new Promise((resolve) => {
    const req = http.get(`http://${target}`, (r) => {
      r.on("data", () => {});
      r.on("end", resolve);
    });
    req.on("error", resolve);
    req.setTimeout(8000, () => { req.destroy(); resolve(); });
  });
}

const app = express();
for (const route of ROUTES) {
  app.get(`/${route}`, async (_req, res) => {
    // Logged inside the active request span → carries trace_id/span_id for
    // trace↔log correlation.
    logger.info({ route }, `handling ${route}`);
    await sleep(latency() * 0.5);
    await dbQuery();
    await Promise.all(DEPS.map(callDep));
    if (Math.random() < ERR) {
      logger.error({ route }, `${route} failed (simulated)`);
      res.status(500).json({ error: "simulated failure", svc: NAME });
      return;
    }
    logger.info({ route }, `${route} ok`);
    res.json({ ok: true, svc: NAME, route });
  });
}
app.listen(PORT, () => console.log(`[sim] ${NAME} listening on :${PORT} routes=${ROUTES.join(",")}`));
