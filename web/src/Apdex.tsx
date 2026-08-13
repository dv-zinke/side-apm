import { useEffect, useRef, useState } from "react";
import { useLiveTxns } from "./live";

// Apdex from the live stream (honest, not derived from percentiles).
//   satisfied  d ≤ T,  tolerating  T < d ≤ 4T,  frustrated  d > 4T or error.
//   score = (satisfied + tolerating/2) / total over a rolling window.
const T = 500;
const WINDOW_MS = 5 * 60 * 1000;

type Sample = { time: number; kind: 0 | 1 | 2 }; // 0 sat, 1 tol, 2 frus

function rating(score: number) {
  if (score >= 0.94) return { label: "Excellent", tone: "ok" as const };
  if (score >= 0.85) return { label: "Good", tone: "ok" as const };
  if (score >= 0.7) return { label: "Fair", tone: "warn" as const };
  if (score >= 0.5) return { label: "Poor", tone: "warn" as const };
  return { label: "Unacceptable", tone: "err" as const };
}

export function ApdexCard() {
  const buf = useRef<Sample[]>([]);
  const [score, setScore] = useState<number | null>(null);

  useLiveTxns((x) => {
    const d = x.durationMs;
    const kind: 0 | 1 | 2 = x.isError || d > 4 * T ? 2 : d <= T ? 0 : 1;
    buf.current.push({ time: Date.now(), kind });
  });
  useEffect(() => {
    const iv = setInterval(() => {
      const cut = Date.now() - WINDOW_MS;
      buf.current = buf.current.filter((b) => b.time > cut);
      const n = buf.current.length;
      if (!n) { setScore(null); return; }
      let sat = 0, tol = 0;
      for (const b of buf.current) { if (b.kind === 0) sat++; else if (b.kind === 1) tol++; }
      setScore((sat + tol / 2) / n);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const r = score == null ? null : rating(score);
  return (
    <div className="kpi-card">
      <div className="kpi-label">Apdex · T={T}ms</div>
      <div className={`kpi-value${r ? " " + r.tone : ""}`}>{score == null ? "—" : score.toFixed(2)}</div>
      {r && <span className={`chip ${r.tone}`} style={{ alignSelf: "flex-start" }}><span className="dot" />{r.label}</span>}
    </div>
  );
}
