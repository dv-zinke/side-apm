import { useEffect, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import { liveTxnStream } from "./api";

type Point = { value: [number, number]; isError: boolean };

export function XView() {
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

  const option = {
    backgroundColor: "transparent",
    tooltip: { formatter: (p: any) => `${p.value[1].toFixed(1)} ms` },
    xAxis: { type: "time", axisLabel: { color: "#999" } },
    yAxis: { type: "value", name: "ms", axisLabel: { color: "#999" } },
    series: [{
      type: "scatter", symbolSize: 7,
      data: points.map((p) => ({ value: p.value, itemStyle: { color: p.isError ? "#e66" : "#4af" } })),
    }],
  };
  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>실시간 X-View · 최근 트랜잭션 {points.length}건 (파랑=정상, 빨강=에러)</div>
      <ReactECharts option={option} style={{ height: "calc(100vh - 90px)" }} theme="dark" notMerge={false} lazyUpdate />
    </div>
  );
}
