import { useEffect, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { useTheme } from "./theme";
import { chartColors } from "./chart";
import { useLiveTxns } from "./live";
import { useNav } from "./nav";
import { liveToTxn } from "./api";
import type { LiveTxn } from "./api";

type Tier = "ok" | "slow" | "err";
type Point = { value: [number, number]; tier: Tier; t: LiveTxn };

const SLOW_MS = 600;
const VERYSLOW_MS = 1500;
const WINDOW_MS = 10 * 60 * 1000;

export function tierOf(d: number, isErr: boolean): Tier {
  if (isErr || d >= VERYSLOW_MS) return "err";
  if (d >= SLOW_MS) return "slow";
  return "ok";
}

// WhaTap-style heatmap: every transaction plotted at (time, latency), squares
// coloured by speed tier; the time axis rolls as new points arrive.
export function Heatmap({ compact }: { compact?: boolean }) {
  const { theme } = useTheme();
  const { openTrace } = useNav();
  const c = chartColors(theme);
  const [points, setPoints] = useState<Point[]>([]);
  const buf = useRef<Point[]>([]);

  useLiveTxns((t) => {
    const ts = new Date(t.startTime).getTime();
    buf.current.push({ value: [ts, t.durationMs], tier: tierOf(t.durationMs, t.isError), t });
  });
  useEffect(() => {
    const iv = setInterval(() => {
      const cut = Date.now() - WINDOW_MS;
      buf.current = buf.current.filter((p) => p.value[0] > cut).slice(-4000);
      setPoints([...buf.current]);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const col: Record<Tier, string> = { ok: c.accent, slow: c.warn, err: c.err };
  const counts = points.reduce((a, p) => { a[p.tier]++; return a; }, { ok: 0, slow: 0, err: 0 });
  const option = {
    backgroundColor: "transparent",
    animation: false,
    tooltip: { formatter: (p: any) => `${p.value[1].toFixed(0)} ms`, backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
    grid: { left: 52, right: 16, top: 10, bottom: 24 },
    xAxis: { type: "time", axisLabel: { color: c.axis }, axisLine: { lineStyle: { color: c.split } }, splitLine: { show: false } },
    yAxis: { type: "value", min: 0, name: "ms", nameTextStyle: { color: c.axis }, axisLabel: { color: c.axis }, splitLine: { lineStyle: { color: c.split } } },
    series: [{
      type: "scatter", symbol: "rect", symbolSize: compact ? 8 : 9,
      data: points.map((p) => ({ value: p.value, itemStyle: { color: col[p.tier], opacity: 0.95 }, tx: p.t })),
    }],
  };
  const onEvents = { click: (p: any) => { if (p?.data?.tx) openTrace(liveToTxn(p.data.tx)); } };
  return (
    <div className="hm">
      <div className="pane-head" style={{ position: "static", borderTop: 0, borderBottom: 0, padding: "0 0 var(--sp-1)" }}>
        <span className="pane-title">히트맵 · 최근 10분 <span className="hint-inline">점을 클릭하면 트레이스</span></span>
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
