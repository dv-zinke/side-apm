import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { fetchContainers, fetchContainerSeries } from "./api";
import type { Container } from "./api";
import { EmptyState, Skeleton } from "./states";
import { useTheme } from "./theme";
import { chartColors } from "./chart";

function mb(n: number) { return n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : (n / 1e6).toFixed(0) + " MB"; }
function bar(pct: number, tone: string) {
  return (
    <div className="ctr-bar"><div className={`ctr-bar-fill ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>
  );
}
const cpuTone = (p: number) => (p > 80 ? "err" : p > 50 ? "warn" : "ok");

function SeriesModal({ name, onClose }: { name: string; onClose: () => void }) {
  const { theme } = useTheme();
  const c = chartColors(theme);
  const cpu = useQuery({ queryKey: ["ctr-series", name, "cpu"], queryFn: () => fetchContainerSeries(name, "cpu_pct"), refetchInterval: 10000 });
  const mem = useQuery({ queryKey: ["ctr-series", name, "mem"], queryFn: () => fetchContainerSeries(name, "mem_pct"), refetchInterval: 10000 });
  const mk = (title: string, pts: { time: string; value: number }[] | undefined, color: string, unit: string) => ({
    backgroundColor: "transparent", animation: false,
    title: { text: title, textStyle: { color: c.axis, fontSize: 12, fontWeight: 500 } },
    tooltip: { trigger: "axis", backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
    grid: { left: 44, right: 12, top: 30, bottom: 24 },
    xAxis: { type: "time", axisLabel: { color: c.axis }, axisLine: { lineStyle: { color: c.split } } },
    yAxis: { type: "value", axisLabel: { color: c.axis, formatter: `{value}${unit}` }, splitLine: { lineStyle: { color: c.split } } },
    series: [{ type: "line", smooth: true, symbol: "none", areaStyle: { color, opacity: 0.14 }, lineStyle: { color, width: 1.5 }, data: (pts ?? []).map((p) => [new Date(p.time).getTime(), Math.round(p.value * 10) / 10]) }],
  });
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title"><span className="modal-svc">컨테이너</span><span className="modal-txn">{name}</span></div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">✕</button>
        </header>
        <div className="modal-body" style={{ display: "grid", gap: "var(--sp-4)" }}>
          <div style={{ height: 220 }}><ReactECharts option={mk("CPU %", cpu.data, c.accent, "%")} style={{ height: "100%" }} notMerge /></div>
          <div style={{ height: 220 }}><ReactECharts option={mk("메모리 %", mem.data, c.ok, "%")} style={{ height: "100%" }} notMerge /></div>
        </div>
      </div>
    </div>
  );
}

export function Infra() {
  const { data, isLoading } = useQuery({ queryKey: ["containers"], queryFn: fetchContainers, refetchInterval: 5000 });
  const [sel, setSel] = useState<string | null>(null);

  return (
    <div className="content-scroll">
      {sel && <SeriesModal name={sel} onClose={() => setSel(null)} />}
      <div className="infra-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">컨테이너 · Docker <span className="hint-inline">행을 클릭하면 시계열</span></span>
          {data && <span className="chip muted" style={{ marginLeft: "auto" }}><span className="dot" />{data.length}개</span>}
        </div>
        {isLoading ? (
          <Skeleton rows={8} />
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            title="아직 컨테이너 지표가 없어요"
            body="dockermon 수집기가 Docker 소켓을 읽어 컨테이너별 CPU·메모리·네트워크를 보내면 여기에 모여요."
          />
        ) : (
          <table className="tbl ctr-tbl">
            <thead>
              <tr><th>컨테이너</th><th>상태</th><th className="ctr-metric">CPU</th><th className="ctr-metric">메모리</th><th className="r">네트워크 I/O</th></tr>
            </thead>
            <tbody>
              {(data ?? []).map((c: Container) => (
                <tr key={c.container} tabIndex={0} onClick={() => setSel(c.container)} onKeyDown={(e) => { if (e.key === "Enter") setSel(c.container); }}>
                  <td className="svc" title={c.image}>{c.container}</td>
                  <td><span className={`chip ${c.status === "running" ? "ok" : c.status === "exited" ? "err" : "muted"}`}><span className="dot" />{c.status}</span></td>
                  <td className="ctr-metric"><div className="ctr-cell">{bar(c.cpuPct, cpuTone(c.cpuPct))}<span className="ctr-val">{c.cpuPct.toFixed(1)}%</span></div></td>
                  <td className="ctr-metric"><div className="ctr-cell">{bar(c.memPct, cpuTone(c.memPct))}<span className="ctr-val">{mb(c.memBytes)} · {c.memPct.toFixed(0)}%</span></div></td>
                  <td className="r ctr-net">↓{mb(c.netRx)} ↑{mb(c.netTx)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
