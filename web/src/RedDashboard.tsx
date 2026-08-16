import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { fetchServices, fetchRED, fetchDeploys, fetchExemplars } from "./api";
import type { Transaction } from "./api";
import { EmptyState, Skeleton, IconX } from "./states";
import { useTheme } from "./theme";
import { chartColors } from "./chart";
import { useNav } from "./nav";

function ExemplarModal({ service, fromISO, toISO, label, onClose }: { service: string; fromISO: string; toISO: string; label: string; onClose: () => void }) {
  const { openTrace } = useNav();
  const { data, isLoading } = useQuery({ queryKey: ["exemplars", service, fromISO], queryFn: () => fetchExemplars(service, fromISO, toISO) });
  const chip = (t: Transaction) => (t.statusCode === "ERROR" || t.durationMs >= 1500 ? "err" : t.durationMs >= 600 ? "warn" : "ok");
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title"><span className="modal-svc">{service} · {label}</span><span className="modal-txn" style={{ fontFamily: "var(--sans)" }}>이 시각의 느린 트레이스</span></div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기"><IconX /></button>
        </header>
        <div className="modal-body" style={{ padding: 0 }}>
          {isLoading ? <div style={{ padding: "var(--sp-4)" }}><Skeleton rows={5} /></div>
            : (data ?? []).length === 0 ? <div className="log-empty">이 시각에 트레이스가 없어요.</div>
            : (
              <table className="tbl">
                <thead><tr><th>트랜잭션</th><th>상태</th><th className="r">경과</th></tr></thead>
                <tbody>
                  {(data ?? []).map((t, i) => (
                    <tr key={t.traceId + i} tabIndex={0} onClick={() => { onClose(); openTrace(t); }} onKeyDown={(e) => { if (e.key === "Enter") { onClose(); openTrace(t); } }}>
                      <td>{t.transactionName || t.traceId.slice(0, 16)}</td>
                      <td><span className={`chip ${chip(t)}`}><span className="dot" />{t.statusCode === "ERROR" ? "ERROR" : "OK"}</span></td>
                      <td className="r">{t.durationMs.toFixed(1)} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      </div>
    </div>
  );
}

export function RedDashboard() {
  const { theme } = useTheme();
  const c = chartColors(theme);
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices, refetchInterval: 10000 });
  const [svc, setSvc] = useState<string>("");
  const service = svc || (services && services[0]) || "";
  // Bucket the key to the minute so it stays stable across renders — otherwise a
  // fresh millisecond timestamp per render churns the query and it never resolves.
  const minute = Math.floor(Date.now() / 60000);
  const { data: red, isLoading } = useQuery({
    queryKey: ["red", service, minute],
    queryFn: () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      return fetchRED(service, from, to);
    },
    enabled: !!service,
    refetchInterval: 10000,
  });
  const { data: deploys } = useQuery({
    queryKey: ["deploys", service, minute],
    queryFn: () => fetchDeploys(service, 50),
    enabled: !!service,
    refetchInterval: 10000,
  });
  const [exemplar, setExemplar] = useState<{ fromISO: string; toISO: string; label: string } | null>(null);
  const pts = red ?? [];
  const hm = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const x = pts.map((p) => hm(new Date(p.minute).getTime()));
  const xset = new Set(x);
  // Map each deploy to its minute-category so echarts can draw a vertical marker.
  const deployMarks = (deploys ?? [])
    .map((d) => ({ x: hm(new Date(d.time).getTime()), version: d.version, description: d.description }))
    .filter((m) => xset.has(m.x));
  const option = {
    backgroundColor: "transparent",
    color: [c.accent, c.err, c.warn],
    tooltip: { trigger: "axis", backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
    legend: { textStyle: { color: c.legend }, top: 0, icon: "roundRect" },
    grid: { left: 52, right: 20, top: 34, bottom: 28 },
    xAxis: { type: "category", data: x, axisLabel: { color: c.axis }, axisLine: { lineStyle: { color: c.split } } },
    yAxis: [
      { type: "value", axisLabel: { color: c.axis }, splitLine: { lineStyle: { color: c.split } } },
      { type: "value", position: "right", axisLabel: { color: c.axis, formatter: "{value} ms" }, splitLine: { show: false } },
    ],
    series: [
      {
        name: "Requests", type: "bar", data: pts.map((p) => p.requestCount), itemStyle: { borderRadius: [2, 2, 0, 0] },
        markLine: deployMarks.length ? {
          symbol: "none", silent: false,
          lineStyle: { color: c.warn, type: "dashed", width: 1 },
          label: { formatter: (p: any) => "🚀 " + (p.data.version ?? ""), color: c.warn, position: "insideEndTop", fontSize: 10 },
          data: deployMarks.map((m) => ({ xAxis: m.x, version: m.version, description: m.description })),
          tooltip: { formatter: (p: any) => `배포 ${p.data.version}<br/>${p.data.description ?? ""}` },
        } : undefined,
      },
      { name: "Errors", type: "bar", data: pts.map((p) => p.errorCount), itemStyle: { borderRadius: [2, 2, 0, 0] } },
      { name: "p95 ms", type: "line", yAxisIndex: 1, smooth: true, symbol: "none", data: pts.map((p) => Math.round(p.p95Ms)) },
    ],
  };
  return (
    <div className="chart-wrap">
      <div className="pane-head" style={{ position: "static", margin: "calc(var(--sp-3) * -1) calc(var(--sp-4) * -1) 0", borderTop: 0 }}>
        <span className="pane-title">RED · 최근 1시간 <span className="hint-inline">막대를 클릭하면 그 시각의 느린 트레이스</span> {deployMarks.length > 0 && <span className="chip warn" style={{ marginLeft: 6 }}><span className="dot" />🚀 배포 {deployMarks.length}</span>}</span>
        <label className="bar" style={{ marginLeft: "auto" }}>
          <span className="field-label">서비스</span>
          <select className="select" value={service} onChange={(e) => setSvc(e.target.value)}>
            {(services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      {isLoading && service ? (
        <Skeleton rows={6} />
      ) : pts.length === 0 ? (
        <EmptyState
          title="이 구간에 데이터가 없어요"
          body="선택한 서비스의 최근 1시간 집계가 아직 비어 있어요. 트래픽이 흐르면 분당 지표가 채워져요."
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <ReactECharts option={option} style={{ height: "100%" }} notMerge onEvents={{
            click: (p: any) => {
              const pt = pts[p.dataIndex];
              if (!pt) return;
              const start = new Date(pt.minute);
              const end = new Date(start.getTime() + 60000);
              setExemplar({ fromISO: start.toISOString(), toISO: end.toISOString(), label: hm(start.getTime()) });
            },
          }} />
        </div>
      )}
      {exemplar && <ExemplarModal service={service} fromISO={exemplar.fromISO} toISO={exemplar.toISO} label={exemplar.label} onClose={() => setExemplar(null)} />}
    </div>
  );
}
