import { useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { fetchServiceMap } from "./api";
import { EmptyState, IconGraph } from "./states";
import { useTheme } from "./theme";
import { chartColors } from "./chart";
import { useNav } from "./nav";

export function ServiceMap() {
  const { theme } = useTheme();
  const { openService } = useNav();
  const c = chartColors(theme);
  const { data } = useQuery({ queryKey: ["servicemap"], queryFn: fetchServiceMap, refetchInterval: 10000 });
  const nodes = (data?.nodes ?? []).map((n) => ({
    name: n.name,
    symbolSize: Math.min(64, 22 + n.requestCount),
    itemStyle: {
      color: n.errorCount > 0 ? c.err : c.accent,
      shadowColor: n.errorCount > 0 ? "rgba(217,58,65,.45)" : "rgba(56,189,248,.4)",
      shadowBlur: 16,
    },
  }));
  const links = (data?.edges ?? []).map((e) => ({
    source: e.from, target: e.to,
    label: { show: true, formatter: `${e.callCount} · ${e.avgMs.toFixed(0)}ms`, color: c.axis, fontSize: 11 },
    lineStyle: { color: e.errorCount > 0 ? c.err : c.linkIdle, width: 1.5, curveness: 0.12 },
  }));
  const option = {
    backgroundColor: "transparent",
    tooltip: { backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
    series: [{
      type: "graph", layout: "force", roam: true, draggable: true,
      label: { show: true, color: c.tipText, fontSize: 12, fontWeight: 500 },
      force: { repulsion: 280, edgeLength: 170 },
      edgeSymbol: ["none", "arrow"], edgeSymbolSize: 8,
      data: nodes, links,
    }],
  };
  return (
    <div className="chart-wrap">
      <div className="pane-head" style={{ position: "static", margin: "calc(var(--sp-3) * -1) calc(var(--sp-4) * -1) 0", borderTop: 0 }}>
        <span className="pane-title">서비스맵 <span className="hint-inline">노드를 클릭하면 트랜잭션</span></span>
        <span className="chart-note" style={{ marginLeft: "auto", marginBottom: 0 }}>
          <span className="legend-key"><i style={{ background: c.accent }} />정상</span>
          <span className="legend-key"><i style={{ background: c.err }} />에러</span>
        </span>
      </div>
      {nodes.length === 0 ? (
        <EmptyState
          icon={<IconGraph />}
          title="서비스맵을 그릴 데이터가 없어요"
          body="최근 15분간 서비스 간 호출이 관측되면 노드와 간선이 자동으로 그려져요."
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <ReactECharts
            option={option}
            style={{ height: "100%" }}
            notMerge
            onEvents={{ click: (p: any) => { if (p?.dataType === "node" && p?.name) openService(p.name); } }}
          />
        </div>
      )}
    </div>
  );
}
