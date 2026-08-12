const express = require("express");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3001;

// Child endpoint — produces a nested SERVER span with some latency.
app.get("/inventory", (req, res) => {
  setTimeout(() => res.json({ stock: "in-stock" }), 120);
});

// Entry endpoint — makes an internal HTTP call so the trace has
// SERVER (/buy-request) -> CLIENT (http get) -> SERVER (/inventory) spans.
app.get("/buy-request", (req, res) => {
  http
    .get(`http://localhost:${PORT}/inventory`, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => {
        try {
          res.json({ ordered: JSON.parse(body).stock });
        } catch (e) {
          res.status(500).json({ error: String(e) });
        }
      });
    })
    .on("error", (e) => res.status(500).json({ error: e.message }));
});

app.listen(PORT, () => console.log(`demo listening on :${PORT}`));
