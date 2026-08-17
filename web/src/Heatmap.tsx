import { useEffect, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { useTheme } from "./theme";
import { chartColors } from "./chart";
import { useLiveTxns } from "./live";
import { useNav } from "./nav";
import { liveToTxn, fetchRecentTxns } from "./api";
import type { LiveTxn } from "./api";
import { TxnListModal } from "./TxnListModal";

type Tier = "ok" | "slow" | "err";
type Point = { value: [number, number]; tier: Tier; t: LiveTxn };

const SLOW_MS = 600;
const VERYSLOW_MS = 1500;
const WINDOW_MS = 5 * 60 * 1000;

// Grid: 3-second time columns × 0–10s latency rows (WhaTap-style block map).
const BIN_SEC = 3;
const X_BINS = (WINDOW_MS / 1000) / BIN_SEC; // 100 columns
const MAX_MS = 10000;
const Y_BINS = 50;                            // 200ms rows, 0–10s
const Y_STEP = MAX_MS / Y_BINS;

export function tierOf(d: number, isErr: boolean): Tier {
  if (isErr || d >= VERYSLOW_MS) return "err";
  if (d >= SLOW_MS) return "slow";
  return "ok";
}
const rankOf = (t: Tier) => (t === "err" ? 2 : t === "slow" ? 1 : 0);

type Cell = { xi: number; yi: number; rank: number; tier: Tier; t: LiveTxn; n: number };

export function Heatmap({ services }: { services?: string[] } = {}) {
  const { theme } = useTheme();
  const { openTrace } = useNav();
  const c = chartColors(theme);
  const chartRef = useRef<any>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [selection, setSelection] = useState<{ txns: LiveTxn[]; label: string } | null>(null);
  const buf = useRef<Point[]>([]);
  const scopeKey = services ? services.join(",") : "";

  const add = (t: LiveTxn) => {
    if (services && !services.includes(t.service)) return; // scoped to enabled services
    const ts = new Date(t.startTime).getTime();
    buf.current.push({ value: [ts, t.durationMs], tier: tierOf(t.durationMs, t.isError), t });
  };
  useLiveTxns(add);
  useEffect(() => { buf.current = []; setPoints([]); }, [scopeKey]); // reset on scope change
  useEffect(() => {
    let alive = true;
    fetchRecentTxns(5).then((txns) => { if (alive) { txns.forEach(add); setPoints([...buf.current]); } }).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const iv = setInterval(() => {
      const cut = Date.now() - WINDOW_MS;
      buf.current = buf.current.filter((p) => p.value[0] > cut).slice(-12000);
      setPoints([...buf.current]);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  // Enable drag-to-select (brush) without a toolbox button.
  useEffect(() => {
    const inst = chartRef.current?.getEchartsInstance?.();
    inst?.dispatchAction({ type: "takeGlobalCursor", key: "brush", brushOption: { brushType: "rect", brushMode: "single" } });
  });

  const col: Record<Tier, string> = { ok: c.accent, slow: c.warn, err: c.err };
  const counts = points.reduce((a, p) => { a[p.tier]++; return a; }, { ok: 0, slow: 0, err: 0 });

  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = Math.floor(nowSec / BIN_SEC) * BIN_SEC - (X_BINS - 1) * BIN_SEC;
  const xiOf = (ms: number) => Math.floor((ms / 1000 - startSec) / BIN_SEC);
  const yiOf = (ms: number) => Math.min(Y_BINS - 1, Math.floor(ms / Y_STEP));

  const cells = new Map<string, Cell>();
  for (const p of points) {
    const xi = xiOf(p.value[0]);
    if (xi < 0 || xi >= X_BINS) continue;
    const yi = yiOf(p.value[1]);
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
    brush: {
      xAxisIndex: 0, yAxisIndex: 0, brushType: "rect", brushMode: "single",
      transformable: false, throttleType: "debounce", throttleDelay: 250, removeOnClick: true,
      brushStyle: { borderColor: c.accent, borderWidth: 1, color: "rgba(56,189,248,0.14)" },
      z: 10,
    },
    grid: { left: 40, right: 12, top: 8, bottom: 28 },
    xAxis: {
      type: "category", data: xLabels,
      axisLabel: { color: c.axis, interval: 19, fontSize: 10 },
      axisLine: { lineStyle: { color: c.split } }, axisTick: { show: false }, splitArea: { show: false },
    },
    yAxis: {
      type: "category", data: yLabels,
      axisLabel: { color: c.axis, interval: 0, fontSize: 10 },
      axisLine: { lineStyle: { color: c.split } }, axisTick: { show: false }, splitArea: { show: false },
    },
    series: [{
      type: "heatmap", data,
      itemStyle: { borderColor: c.tip, borderWidth: 0.4 },
      emphasis: { itemStyle: { borderColor: c.tipText, borderWidth: 1 } },
    }],
  };

  // Collect the transactions inside a drag-selected rectangle.
  const onBrush = (params: any) => {
    const area = params?.batch?.[0]?.areas?.[0] ?? params?.areas?.[0];
    if (!area?.coordRange) return;
    const [[x0, x1], [y0, y1]] = area.coordRange;
    const [xa, xb] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ya, yb] = [Math.min(y0, y1), Math.max(y0, y1)];
    const picked = points.filter((p) => {
      const xi = xiOf(p.value[0]); if (xi < 0 || xi >= X_BINS) return false;
      const yi = yiOf(p.value[1]);
      return xi >= xa && xi <= xb && yi >= ya && yi <= yb;
    }).map((p) => p.t);
    if (picked.length) {
      const lo = (ya * Y_STEP / 1000).toFixed(1), hi = ((yb + 1) * Y_STEP / 1000).toFixed(1);
      setSelection({ txns: picked, label: `${xLabels[Math.max(0, xa)]}~${xLabels[Math.min(X_BINS - 1, xb)]} · ${lo}~${hi}s` });
    }
  };
  const onEvents = {
    brushEnd: onBrush,
    brushselected: onBrush,
    click: (p: any) => { if (p?.data?.cell?.t) openTrace(liveToTxn(p.data.cell.t)); },
  };

  return (
    <div className="hm">
      <div className="pane-head" style={{ position: "static", borderTop: 0, borderBottom: 0, padding: "0 0 var(--sp-1)" }}>
        <span className="pane-title">히트맵 · 걸린시간 0~10s <span className="hint-inline">드래그로 구간 선택 · 클릭으로 트레이스</span></span>
        <span className="chart-note" style={{ marginLeft: "auto", marginBottom: 0 }}>
          <span className="legend-key"><i style={{ background: c.accent }} />정상 {counts.ok}</span>
          <span className="legend-key"><i style={{ background: c.warn }} />느림 {counts.slow}</span>
          <span className="legend-key"><i style={{ background: c.err }} />에러/지연 {counts.err}</span>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <ReactECharts ref={chartRef} option={option} style={{ height: "100%" }} notMerge lazyUpdate onEvents={onEvents} />
        {points.length === 0 && (
          <div className="chart-empty-overlay"><span><span className="live-dot" />실시간 트랜잭션을 기다리고 있어요</span></div>
        )}
      </div>
      {selection && (
        <TxnListModal
          txns={selection.txns} label={selection.label}
          onClose={() => setSelection(null)}
          onPick={(t) => { setSelection(null); openTrace(liveToTxn(t)); }}
        />
      )}
    </div>
  );
}
