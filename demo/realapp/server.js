// A REAL Node/Express app (not the simulator). It's auto-instrumented by
// OpenTelemetry and makes REAL outbound HTTP calls to a public API, so the
// traces carry real work and real internet latency — proof the APM ingests
// genuine third-party application data, polyglot via standard OTLP.
const express = require("express");
const pino = require("pino");

const log = pino({ name: process.env.OTEL_SERVICE_NAME || "shop-web" });
const app = express();
const UPSTREAM = process.env.UPSTREAM_API || "https://jsonplaceholder.typicode.com";

async function getJSON(url) {
  const r = await fetch(url); // native fetch → auto-instrumented (undici) → real client span
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

// Browse the catalog — one real upstream call.
app.get("/browse", async (_req, res) => {
  log.info("browse");
  try {
    const products = await getJSON(`${UPSTREAM}/posts?_limit=10`);
    res.json({ count: products.length });
  } catch (e) {
    log.error({ err: String(e) }, "browse failed");
    res.status(502).json({ error: "upstream unavailable" });
  }
});

// Place an order — a small fan-out of real upstream calls (user + payment + confirm).
app.get("/buy", async (_req, res) => {
  const id = 1 + Math.floor(Math.random() * 10);
  log.info({ id }, "buy");
  try {
    const user = await getJSON(`${UPSTREAM}/users/${id}`);
    const cart = await getJSON(`${UPSTREAM}/carts/${id}`).catch(() => ({ id }));
    // "payment" — a real POST with real round-trip latency
    const pay = await fetch(`${UPSTREAM}/posts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: id, amount: Math.round(Math.random() * 20000) }),
    });
    if (!pay.ok) throw new Error(`payment ${pay.status}`);
    res.json({ ok: true, user: user.name, cart: cart.id });
  } catch (e) {
    log.error({ err: String(e) }, "buy failed");
    res.status(502).json({ error: "order failed" });
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

const port = Number(process.env.PORT || 3200);
app.listen(port, () => log.info(`real app listening on ${port} → ${UPSTREAM}`));

// Self-drive real traffic so traces flow continuously once running.
const routes = ["/browse", "/buy", "/buy", "/browse"];
setTimeout(() => {
  setInterval(() => {
    const path = routes[Math.floor(Math.random() * routes.length)];
    fetch(`http://localhost:${port}${path}`).then((r) => r.text()).catch(() => {});
  }, 1500);
}, 4000);
