import { useEffect, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { useTheme } from "./theme";
import { chartColors } from "./chart";
import { useLiveTxns } from "./live";
import { useNav } from "./nav";
import { liveToTxn, fetchRecentTxns } from "./api";
import type { LiveTxn } from "./api";

type Tier = "ok" | "slow" | "err";
type Point = { value: [number, number]; tier: Tier; t: LiveTxn };

const SLOW_MS = 600;
const VERYSLOW_MS = 1500;
const WINDOW_MS = 5 * 60 * 1000;

// Grid: 10-second time columns × 0–10s latency rows (WhaTap-style block map).
const BIN_SEC = 10;
const X_BINS = (WINDOW_MS / 1000) / BIN_SEC; // 30 columns
const MAX_MS = 10000;
const Y_BINS = 20;                            // 500ms rows, 0–10s
const Y_STEP = MAX_MS / Y_BINS;

export function tierOf(d: number, isErr: boolean): Tier {
  if (isErr || d >= VERYSLOW_MS) return "err";
  if (d >= SLOW_MS) return "slow";
  return "ok";
}
const rankOf = (t: Tier) => (t === "err" ? 2 : t === "slow" ? 1 : 0);

type Cell = { xi: number; yi: number; rank: number; tier: Tier; t: LiveTxn; n: number };

// WhaTap-style heatmap: transactions binned into 10s × 0.5s cells; each cell is
// one block coloured by its worst tier. No overlapping scatter.
export function Heatmap() {
  const { theme } = useTheme();
  const { openTrace } = useNav();
  const c = chartColors(theme);
  const [points, setPoints] = useState<Point[]>([]);
  const buf = useRef<Point[]>([]);

  const add = (t: LiveTxn) => {
    const ts = new Date(t.startTime).getTime();
    buf.current.push({ value: [ts, t.durationMs], tier: tierOf(t.durationMs, t.isError), t });
  };
  useLiveTxns(add);
  useEffect(() => {
    let alive = true;
    fetchRecentTxns(5).then((txns) => { if (alive) { txns.forEach(add); setPoints([...buf.current]); } }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const iv = setInterval(() => {
      const cut = Date.now() - WINDOW_MS;
      buf.current = buf.current.filter((p) => p.value[0] > cut).slice(-8000);
      setPoints([...buf.current]);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const col: Record<Tier, string> = { ok: c.accent, slow: c.warn, err: c.err };
  const counts = points.reduce((a, p) => { a[p.tier]++; return a; }, { ok: 0, slow: 0, err: 0 });

  // Bin into a fixed rolling grid.
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = Math.floor(nowSec / BIN_SEC) * BIN_SEC - (X_BINS - 1) * BIN_SEC;
  const cells = new Map<string, Cell>();
  for (const p of points) {
    const xi = Math.floor((p.value[0] / 1000 - startSec) / BIN_SEC);
    if (xi < 0 || xi >= X_BINS) continue;
    const yi = Math.min(Y_BINS - 1, Math.floor(p.value[1] / Y_STEP));
    const key = xi + "_" + yi;
    const rank = rankOf(p.tier);
    const cur = cells.get(key);
    if (!cur) cells.set(key, { xi, yi, rank, tier: p.tier, t: p.t, n: 1 });
    else { cur.n++; if (rank > cur.rank) { cur.rank = rank; cur.tier = p.tier; cur.t = p.t; } }
  }
  const data = [...cells.values()].map((cell) => ({
    value: [cell.xi, cell.yi, cell.n], itemStyle: { color: col[cell.tier] }, cell,
  }));

  const xLabels = Array.from({ length: X_BINS }, (_, i) => {
    const d = new Date((startSec + i * BIN_SEC) * 1000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  });
  const yLabels = Array.from({ length: Y_BINS }, (_, i) => {
    const s = (i * Y_STEP) / 1000;
    return Number.isInteger(s) ? `${s}s` : "";
  });

  const option = {
    backgroundColor: "transparent",
    animation: false,
    tooltip: {
      backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText },
      formatter: (p: any) => {
        const cell: Cell = p.data.cell;
        const lo = (cell.yi * Y_STEP / 1000).toFixed(1), hi = ((cell.yi + 1) * Y_STEP / 1000).toFixed(1);
        return `${xLabels[cell.xi]} · ${lo}~${hi}s<br/>${cell.n}건`;
      },
    },
    grid: { left: 44, right: 14, top: 8, bottom: 30 },
    xAxis: {
      type: "category", data: xLabels,
      axisLabel: { color: c.axis, interval: 5, fontSize: 10 },
      axisLine: { lineStyle: { color: c.split } }, axisTick: { show: false }, splitArea: { show: false },
    },
    yAxis: {
      type: "category", data: yLabels, inverse: false,
      axisLabel: { color: c.axis, interval: 0, fontSize: 10 },
      axisLine: { lineStyle: { color: c.split } }, axisTick: { show: false }, splitArea: { show: false },
    },
    series: [{
      type: "heatmap", data,
      itemStyle: { borderColor: c.tip, borderWidth: 1 },
      emphasis: { itemStyle: { borderColor: c.tipText, borderWidth: 1 } },
    }],
  };
  const onEvents = { click: (p: any) => { if (p?.data?.cell?.t) openTrace(liveToTxn(p.data.cell.t)); } };
  return (
    <div className="hm">
      <div className="pane-head" style={{ position: "static", borderTop: 0, borderBottom: 0, padding: "0 0 var(--sp-1)" }}>
        <span className="pane-title">히트맵 · 걸린시간 0~10s <span className="hint-inline">블럭을 클릭하면 트레이스</span></span>
        <span className="chart-note" style={{ marginLeft: "auto", marginBottom: 0 }}>
          <span className="legend-key"><i style={{ background: c.accent }} />정상 {counts.ok}</span>
          <span className="legend-key"><i style={{ background: c.warn }} />느림 {counts.slow}</span>
          <span className="legend-key"><i style={{ background: c.err }} />에러/지연 {counts.err}</span>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <ReactECharts option={option} style={{ height: "100%" }} notMerge lazyUpdate onEvents={onEvents} />
        {points.length === 0 && (
          <div className="chart-empty-overlay"><span><span className="live-dot" />실시간 트랜잭션을 기다리고 있어요</span></div>
        )}
      </div>
    </div>
  );
}
