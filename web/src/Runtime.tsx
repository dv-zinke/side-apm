import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { fetchServices, fetchMetricNames, fetchMetric } from "./api";
import { EmptyState, Skeleton } from "./states";
import { useTheme } from "./theme";
import { chartColors, type ChartColors } from "./chart";

// Compact value formatter — bytes→MB/GB, fractions→%, big→K/M.
function fmt(name: string, v: number | null): string {
  if (v == null) return "—";
  if (name.includes("memory") || name.includes("heap") || name.endsWith(".size") || name.includes("bytes")) {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + " GB";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + " MB";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + " KB";
    return v.toFixed(0) + " B";
  }
  if (name.includes("utilization")) return (v * 100).toFixed(1) + " %";
  // eventloop delay/time are seconds → show as ms
  if (name.includes("delay") || name.includes(".time") || name.includes("duration")) {
    const ms = v * 1000;
    return (ms >= 100 ? ms.toFixed(0) : ms.toFixed(2)) + " ms";
  }
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return v.toFixed(v < 10 ? 2 : 0);
}

function MetricCard({ service, name, c }: { service: string; name: string; c: ChartColors }) {
  const minute = Math.floor(Date.now() / 60000);
  const { data } = useQuery({
    queryKey: ["metric", service, name, minute],
    queryFn: () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      return fetchMetric(service, name, from, to);
    },
    enabled: !!service,
    refetchInterval: 10000,
  });
  const pts = data ?? [];
  const last = pts.length ? pts[pts.length - 1].value : null;
  const option = {
    backgroundColor: "transparent",
    animation: false,
    grid: { left: 4, right: 4, top: 6, bottom: 4 },
    tooltip: { trigger: "axis", backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText }, formatter: (p: any) => fmt(name, p[0].value[1]) },
    xAxis: { type: "time", show: false },
    yAxis: { type: "value", scale: true, show: false },
    series: [{
      type: "line", smooth: true, symbol: "none",
      lineStyle: { color: c.accent, width: 1.5 },
      areaStyle: { color: c.accent, opacity: 0.12 },
      data: pts.map((p) => [new Date(p.time).getTime(), p.value]),
    }],
  };
  return (
    <div className="metric-card">
      <div className="metric-name" title={name}>{name}</div>
      <div className="metric-val">{fmt(name, last)}</div>
      <div className="metric-spark">
        <ReactECharts option={option} style={{ height: "100%" }} notMerge />
      </div>
    </div>
  );
}

export function Runtime() {
  const { theme } = useTheme();
  const c = chartColors(theme);
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices, refetchInterval: 30000 });
  const [svc, setSvc] = useState("");
  const service = svc || (services && services[0]) || "";
  const { data: names, isLoading } = useQuery({
    queryKey: ["metric-names", service],
    queryFn: () => fetchMetricNames(service),
    enabled: !!service,
    refetchInterval: 30000,
  });

  return (
    <div className="content-scroll">
      <div className="runtime">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">런타임 메트릭</span>
          <label className="bar" style={{ marginLeft: "auto" }}>
            <span className="field-label">서비스</span>
            <select className="select" value={service} onChange={(e) => setSvc(e.target.value)}>
              {(services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>
        {isLoading ? (
          <Skeleton rows={8} />
        ) : (names ?? []).length === 0 ? (
          <EmptyState
            title="이 서비스의 런타임 메트릭이 없어요"
            body="에이전트가 OTLP 메트릭(런타임/시스템)을 보내면 여기에 시계열로 모여요."
            hint="sim 프로파일은 Node 런타임 메트릭을 전송해요"
          />
        ) : (
          <div className="metric-grid">
            {(names ?? []).map((n) => <MetricCard key={n} service={service} name={n} c={c} />)}
          </div>
        )}
      </div>
    </div>
  );
}
