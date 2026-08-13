import { useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { fetchServiceMap } from "./api";

export function ServiceMap() {
  const { data } = useQuery({ queryKey: ["servicemap"], queryFn: fetchServiceMap, refetchInterval: 10000 });
  const nodes = (data?.nodes ?? []).map((n) => ({
    name: n.name,
    symbolSize: Math.min(60, 20 + n.requestCount),
    itemStyle: { color: n.errorCount > 0 ? "#e66" : "#4a8" },
  }));
  const links = (data?.edges ?? []).map((e) => ({
    source: e.from, target: e.to,
    label: { show: true, formatter: `${e.callCount} · ${e.avgMs.toFixed(0)}ms` },
    lineStyle: { color: e.errorCount > 0 ? "#e66" : "#888", width: 2, curveness: 0.1 },
  }));
  const option = {
    backgroundColor: "transparent",
    tooltip: {},
    series: [{
      type: "graph", layout: "force", roam: true, draggable: true,
      label: { show: true, color: "#ddd" },
      force: { repulsion: 260, edgeLength: 160 },
      edgeSymbol: ["none", "arrow"],
      data: nodes, links,
    }],
  };
  return <ReactECharts option={option} style={{ height: "calc(100vh - 46px)" }} theme="dark" />;
}
