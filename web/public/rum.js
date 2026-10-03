/* APM RUM — lightweight browser agent. Drop-in:
     <script src="http://localhost:4318/rum.js" data-endpoint="http://localhost:4318"></script>
   Collects pageview / click / error / Web Vitals / resource timing and batches
   them to /v1/rum. No dependencies. */
(function () {
  var script = document.currentScript || {};
  var EP = (script.getAttribute && script.getAttribute("data-endpoint")) || "http://localhost:4318";
  var URL = EP.replace(/\/$/, "") + "/v1/rum";
  var sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var queue = [];
  var path = function () { return location.pathname; };

  function push(ev) { ev.ts = Date.now(); ev.page = path(); queue.push(ev); if (queue.length >= 20) flush(); }
  function flush() {
    if (!queue.length) return;
    var body = JSON.stringify({ sessionId: sid, page: path(), ua: navigator.userAgent, events: queue.splice(0, queue.length) });
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(URL, new Blob([body], { type: "application/json" }));
      else fetch(URL, { method: "POST", body: body, headers: { "Content-Type": "application/json" }, keepalive: true });
    } catch (e) { /* swallow */ }
  }

  // pageview
  push({ type: "pageview" });

  // clicks — capture a readable target label
  document.addEventListener("click", function (e) {
    var el = e.target;
    if (!el || !el.closest) return;
    var t = el.closest("button, a, [role=button], [role=tab], input, .nav-item, .tab");
    var label = t ? (t.textContent || t.getAttribute("aria-label") || t.tagName).trim().slice(0, 40) : (el.textContent || el.tagName).trim().slice(0, 40);
    if (label) push({ type: "click", target: label });
  }, true);

  // Session replay: record DOM with rrweb, keep the events since the last full
  // snapshot, and ship that window when an error fires (an "error video").
  var replayBuf = [];
  var REPLAY_URL = EP.replace(/\/$/, "") + "/v1/rum/replay";
  (function loadRrweb() {
    var s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.4/dist/rrweb.min.js";
    s.crossOrigin = "anonymous";
    s.onload = function () {
      if (!window.rrweb || !window.rrweb.record) return;
      window.rrweb.record({
        emit: function (event, isCheckout) {
          if (isCheckout) replayBuf = []; // new full snapshot → start a fresh window
          replayBuf.push(event);
          if (replayBuf.length > 800) replayBuf.shift();
        },
        checkoutEveryNms: 12000,
        sampling: { mousemove: 100, scroll: 150 },
      });
    };
    document.head.appendChild(s);
  })();
  var lastReplay = 0;
  function sendReplay(msg) {
    var now = Date.now();
    // Cooldown + swallow rejection: a failed replay POST must never re-trigger
    // the error handler (that would loop forever).
    if (now - lastReplay < 5000 || replayBuf.length < 3) return;
    lastReplay = now;
    var body = JSON.stringify({ sessionId: sid, page: path(), message: (msg || "").slice(0, 200), events: replayBuf.slice() });
    try {
      var p = fetch(REPLAY_URL, { method: "POST", body: body, headers: { "Content-Type": "application/json" }, keepalive: true });
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  // front-end errors → log event + capture replay
  window.addEventListener("error", function (e) {
    var msg = (e.message || "Script error").slice(0, 200);
    push({ type: "error", message: msg, stack: (e.error && e.error.stack || "").slice(0, 800) });
    sendReplay(msg);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason || {};
    var msg = ("Unhandled: " + (r.message || r)).slice(0, 200);
    push({ type: "error", message: msg, stack: (r.stack || "").slice(0, 800) });
    sendReplay(msg);
  });

  // Core Web Vitals via PerformanceObserver
  function observe(type, cb) { try { new PerformanceObserver(cb).observe({ type: type, buffered: true }); } catch (e) {} }
  observe("largest-contentful-paint", function (l) { var e = l.getEntries().pop(); if (e) push({ type: "vital", metric: "LCP", value: e.startTime }); });
  var cls = 0;
  observe("layout-shift", function (l) { l.getEntries().forEach(function (e) { if (!e.hadRecentInput) cls += e.value; }); });
  observe("first-input", function (l) { var e = l.getEntries()[0]; if (e) push({ type: "vital", metric: "INP", value: e.processingStart - e.startTime }); });
  observe("paint", function (l) { l.getEntries().forEach(function (e) { if (e.name === "first-contentful-paint") push({ type: "vital", metric: "FCP", value: e.startTime }); }); });

  // resource timing (fetch/xhr/scripts) — sample to keep volume sane
  observe("resource", function (l) {
    l.getEntries().forEach(function (e) {
      if (e.initiatorType !== "fetch" && e.initiatorType !== "xmlhttprequest") return;
      push({ type: "resource", url: (e.name || "").slice(0, 200), value: Math.round(e.duration), status: 200 });
    });
  });

  setInterval(flush, 5000);
  addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") { if (cls) push({ type: "vital", metric: "CLS", value: cls }); flush(); } });
  addEventListener("pagehide", flush);
})();
