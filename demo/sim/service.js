// Generic instrumented service. One process per topology node; OTEL_SERVICE_NAME
// gives it its identity. Each route sleeps (latency profile), calls its
// downstream deps over HTTP (trace context auto-propagates), then maybe errors.
const express = require("express");
const http = require("http");

const NAME = process.env.SVC_NAME || "svc";
const PORT = Number(process.env.SVC_PORT || 3100);
const DEPS = (process.env.SVC_DEPS || "").split(",").filter(Boolean); // host:port list
const BASE = Number(process.env.SVC_BASE || 40);
const JITTER = Number(process.env.SVC_JITTER || 40);
const SPIKE = Number(process.env.SVC_SPIKE || 0);
const ERR = Number(process.env.SVC_ERR || 0);
const ROUTES = (process.env.SVC_ROUTES || "work").split(",").filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    await sleep(latency());
    await Promise.all(DEPS.map(callDep));
    if (Math.random() < ERR) { res.status(500).json({ error: "simulated failure", svc: NAME }); return; }
    res.json({ ok: true, svc: NAME, route });
  });
}
app.listen(PORT, () => console.log(`[sim] ${NAME} listening on :${PORT} routes=${ROUTES.join(",")}`));
