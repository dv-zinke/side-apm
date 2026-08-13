import { useEffect, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { liveTxnStream } from "./api";
import { useTheme } from "./theme";
import { chartColors } from "./chart";

type Point = { value: [number, number]; isError: boolean };

export function XView() {
  const { theme } = useTheme();
  const c = chartColors(theme);
  const [points, setPoints] = useState<Point[]>([]);
  const buf = useRef<Point[]>([]);

  useEffect(() => {
    const close = liveTxnStream((t) => {
      const ts = new Date(t.startTime).getTime();
      buf.current = [...buf.current, { value: [ts, t.durationMs] as [number, number], isError: t.isError }].slice(-500);
    });
    const iv = setInterval(() => setPoints([...buf.current]), 1000);
    return () => { close(); clearInterval(iv); };
  }, []);

  const errors = points.filter((p) => p.isError).length;
  const option = {
    backgroundColor: "transparent",
    tooltip: { formatter: (p: any) => `${p.value[1].toFixed(1)} ms`, backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
    grid: { left: 52, right: 20, top: 16, bottom: 28 },
    xAxis: { type: "time", axisLabel: { color: c.axis }, axisLine: { lineStyle: { color: c.split } }, splitLine: { show: false } },
    yAxis: { type: "value", name: "ms", nameTextStyle: { color: c.axis }, axisLabel: { color: c.axis }, splitLine: { lineStyle: { color: c.split } } },
    series: [{
      type: "scatter", symbolSize: 7,
      data: points.map((p) => ({ value: p.value, itemStyle: { color: p.isError ? c.err : c.accent, opacity: 0.85 } })),
    }],
  };
  return (
    <div className="chart-wrap">
      <div className="pane-head" style={{ position: "static", margin: "calc(var(--sp-3) * -1) calc(var(--sp-4) * -1) 0", borderTop: 0 }}>
        <span className="pane-title">실시간 X-View</span>
        <span className="chart-note" style={{ marginLeft: "auto", marginBottom: 0 }}>
          <span className="legend-key"><i style={{ background: c.accent }} />정상</span>
          <span className="legend-key"><i style={{ background: c.err }} />에러 {errors}</span>
          <span className="chip muted"><span className="dot" />{points.length}건</span>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactECharts option={option} style={{ height: "100%" }} notMerge lazyUpdate />
      </div>
      {points.length === 0 && (
        <div className="chart-empty-overlay">
          <span><span className="live-dot" />실시간 트랜잭션을 기다리고 있어요</span>
        </div>
      )}
    </div>
  );
}
