import { useEffect, useRef, useState } from "react";
import { useTheme } from "./theme";
import { chartColors } from "./chart";
import { useLiveTxns } from "./live";
import { useNav } from "./nav";
import { liveToTxn, fetchRecentTxns } from "./api";
import type { LiveTxn } from "./api";

type Tier = "ok" | "slow" | "err";
type P = { x: number; y: number; r: number; tier: Tier; t: LiveTxn };

const SLOW_MS = 600;   // amber above this
const VERYSLOW_MS = 1500; // red above this
const FLOW_SEC = 4.5;  // time to cross the lane

function tierOf(durationMs: number, isError: boolean): Tier {
  if (isError || durationMs >= VERYSLOW_MS) return "err";
  if (durationMs >= SLOW_MS) return "slow";
  return "ok";
}

/* WhaTap-style live "active transaction speed" lane.
   Each streamed transaction spawns a dot that flows across the lane;
   colour = speed tier, size = duration. Pure canvas + rAF. */
export function SpeedBand() {
  const { theme } = useTheme();
  const { openTrace } = useNav();
  const c = chartColors(theme);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particles = useRef<P[]>([]);
  const spawns = useRef<number[]>([]);
  const [rps, setRps] = useState(0);
  const [tally, setTally] = useState({ ok: 0, slow: 0, err: 0 });

  // Ingest the live stream → spawn particles.
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const spawn = (t: LiveTxn, x: number) => {
    particles.current.push({
      x, y: Math.random(),
      r: 5 + Math.min(6, t.durationMs / 300),
      tier: tierOf(t.durationMs, t.isError),
      t,
    });
  };
  useLiveTxns((t) => {
    // stagger entry across ~1s so 1-second SSE batches read as a continuous
    // stream instead of vertical columns.
    spawn(t, reduce ? Math.random() : 1 + Math.random() * 0.18);
    spawns.current.push(performance.now());
    const tier = tierOf(t.durationMs, t.isError);
    setTally((s) => ({ ...s, [tier]: s[tier] + 1 }));
  });
  // Backfill the lane on mount so it's full of flowing dots immediately.
  useEffect(() => {
    let alive = true;
    fetchRecentTxns(5).then((txns) => {
      if (!alive) return;
      const recent = txns.slice(0, 350);
      // spread evenly across the lane (position ≠ time; it's a live density band)
      recent.forEach((t) => spawn(t, Math.random()));
      setTally((s) => {
        const n = { ...s };
        for (const t of recent) n[tierOf(t.durationMs, t.isError)]++;
        return n;
      });
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // rAF flow + draw.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const col: Record<Tier, string> = { ok: c.accent, slow: c.warn, err: c.err };
    let raf = 0;
    let last = performance.now();
    const draw = (now: number) => {
      const dt = Math.min(60, now - last);
      last = now;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduce) {
        ctx.clearRect(0, 0, w, h);
      } else {
        // Fade the previous frame instead of clearing → each dot leaves a
        // trailing streak, so traffic reads as packets flowing across the wire.
        ctx.globalCompositeOperation = "destination-out";
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
      }
      const speed = 1 / (FLOW_SEC * 1000); // fraction of width per ms
      const arr = particles.current;
      for (let i = arr.length - 1; i >= 0; i--) {
        const p = arr[i];
        if (!reduce) p.x -= speed * dt;
        if (p.x < -0.02) { arr.splice(i, 1); continue; }
        const px = p.x * w;
        const py = 10 + p.y * (h - 20);
        // Small round dot; the fade above turns its motion into a streak.
        const r = p.r * 0.55;
        ctx.fillStyle = col[p.tier];
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      const cap = reduce ? 160 : 2500;
      if (arr.length > cap) arr.splice(0, arr.length - cap);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [c.accent, c.warn, c.err]);

  // Rolling RPS.
  useEffect(() => {
    const iv = setInterval(() => {
      const cut = performance.now() - 1000;
      spawns.current = spawns.current.filter((t) => t > cut);
      setRps(spawns.current.length);
    }, 500);
    return () => clearInterval(iv);
  }, []);

  // Click a flowing dot → open that trace.
  function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    let best: P | null = null, bestD = Infinity;
    for (const p of particles.current) {
      const px = p.x * w, py = 10 + p.y * (h - 20);
      const d = Math.hypot(px - mx, py - my);
      if (d < Math.max(p.r + 5, 10) && d < bestD) { bestD = d; best = p; }
    }
    if (best) openTrace(liveToTxn(best.t));
  }

  return (
    <div className="speedband">
      <div className="speedband-head">
        <span className="pane-title">액티브 트랜잭션 스피드 <span className="hint-inline">점을 클릭하면 트레이스</span></span>
        <span className="rps"><b>{rps}</b> RPS</span>
        <span className="chart-note" style={{ marginBottom: 0 }}>
          <span className="legend-key"><i style={{ background: c.accent }} />정상 {tally.ok}</span>
          <span className="legend-key"><i style={{ background: c.warn }} />느림 {tally.slow}</span>
          <span className="legend-key"><i style={{ background: c.err }} />에러/지연 {tally.err}</span>
        </span>
      </div>
      <div className="speedband-lane">
        <canvas ref={canvasRef} onClick={onCanvasClick} />
        {tally.ok + tally.slow + tally.err === 0 && (
          <div className="chart-empty-overlay"><span><span className="live-dot" />실시간 트랜잭션을 기다리고 있어요</span></div>
        )}
      </div>
    </div>
  );
}
