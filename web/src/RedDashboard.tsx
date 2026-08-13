import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { fetchServices, fetchRED } from "./api";

export function RedDashboard() {
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices, refetchInterval: 10000 });
  const [svc, setSvc] = useState<string>("");
  const service = svc || (services && services[0]) || "";
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: red } = useQuery({
    queryKey: ["red", service, from],
    queryFn: () => fetchRED(service, from, to),
    enabled: !!service,
    refetchInterval: 10000,
  });
  const pts = red ?? [];
  const x = pts.map((p) => p.minute.slice(11, 16));
  const option = {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis" },
    legend: { textStyle: { color: "#ccc" } },
    grid: { left: 48, right: 16, top: 30, bottom: 30 },
    xAxis: { type: "category", data: x, axisLabel: { color: "#999" } },
    yAxis: { type: "value", axisLabel: { color: "#999" } },
    series: [
      { name: "Requests", type: "bar", data: pts.map((p) => p.requestCount) },
      { name: "Errors", type: "bar", data: pts.map((p) => p.errorCount) },
      { name: "p95 ms", type: "line", yAxisIndex: 0, data: pts.map((p) => Math.round(p.p95Ms)) },
    ],
  };
  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8 }}>
        서비스:{" "}
        <select value={service} onChange={(e) => setSvc(e.target.value)}>
          {(services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <ReactECharts option={option} style={{ height: 360 }} theme="dark" />
    </div>
  );
}
