import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import {
  fetchDashboards, saveDashboard, deleteDashboard, fetchServices, fetchContainers,
  fetchRED, fetchApdex, fetchContainerSeries,
} from "./api";
import type { Dashboard, Panel } from "./api";
import { EmptyState, Skeleton, IconX } from "./states";
import { useTheme } from "./theme";
import { chartColors } from "./chart";
import { useAuth } from "./auth";

const PANEL_TYPES = [
  { id: "red", label: "RED 시계열" },
  { id: "apdex", label: "Apdex 지표" },
  { id: "container", label: "컨테이너 CPU" },
] as const;

const rid = () => Math.random().toString(36).slice(2, 9);
const win = () => ({ from: new Date(Date.now() - 3600e3).toISOString(), to: new Date().toISOString() });

function ApdexPanel({ target }: { target: string }) {
  const { data } = useQuery({ queryKey: ["p-apdex", target], queryFn: () => fetchApdex(target), refetchInterval: 15000 });
  const tone = !data?.hasData ? "" : data.score >= 0.94 ? "ok" : data.score >= 0.85 ? "warn" : "err";
  return (
    <div className="cd-stat">
      <div className={`cd-stat-val ${tone}`}>{data?.hasData ? data.score.toFixed(2) : "—"}</div>
      <div className="cd-stat-sub">{target} · T={data?.tMs ?? 500}ms</div>
    </div>
  );
}

function RedPanel({ target }: { target: string }) {
  const { theme } = useTheme();
  const c = chartColors(theme);
  const { data } = useQuery({ queryKey: ["p-red", target], queryFn: () => { const w = win(); return fetchRED(target, w.from, w.to); }, refetchInterval: 15000 });
  const pts = data ?? [];
  const x = pts.map((p) => { const d = new Date(p.minute); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; });
  const option = {
    backgroundColor: "transparent", color: [c.accent, c.err, c.warn], animation: false,
    tooltip: { trigger: "axis", backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
    grid: { left: 40, right: 36, top: 10, bottom: 20 },
    xAxis: { type: "category", data: x, axisLabel: { color: c.axis, fontSize: 9, interval: Math.floor(x.length / 6) }, axisLine: { lineStyle: { color: c.split } } },
    yAxis: [{ type: "value", axisLabel: { color: c.axis, fontSize: 9 }, splitLine: { lineStyle: { color: c.split } } },
      { type: "value", position: "right", axisLabel: { color: c.axis, fontSize: 9, formatter: "{value}ms" }, splitLine: { show: false } }],
    series: [
      { name: "req", type: "bar", data: pts.map((p) => p.requestCount) },
      { name: "err", type: "bar", data: pts.map((p) => p.errorCount) },
      { name: "p95", type: "line", yAxisIndex: 1, smooth: true, symbol: "none", data: pts.map((p) => Math.round(p.p95Ms)) },
    ],
  };
  return <ReactECharts option={option} style={{ height: 180 }} notMerge />;
}

function ContainerPanel({ target }: { target: string }) {
  const { theme } = useTheme();
  const c = chartColors(theme);
  const { data } = useQuery({ queryKey: ["p-ctr", target], queryFn: () => fetchContainerSeries(target, "cpu_pct"), refetchInterval: 15000 });
  const option = {
    backgroundColor: "transparent", animation: false,
    tooltip: { trigger: "axis", backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
    grid: { left: 40, right: 12, top: 10, bottom: 20 },
    xAxis: { type: "time", axisLabel: { color: c.axis, fontSize: 9 }, axisLine: { lineStyle: { color: c.split } } },
    yAxis: { type: "value", axisLabel: { color: c.axis, fontSize: 9, formatter: "{value}%" }, splitLine: { lineStyle: { color: c.split } } },
    series: [{ type: "line", smooth: true, symbol: "none", areaStyle: { color: c.accent, opacity: 0.14 }, lineStyle: { color: c.accent, width: 1.5 }, data: (data ?? []).map((p) => [new Date(p.time).getTime(), Math.round(p.value * 10) / 10]) }],
  };
  return <ReactECharts option={option} style={{ height: 180 }} notMerge />;
}

function PanelView({ panel, editing, onRemove }: { panel: Panel; editing: boolean; onRemove: () => void }) {
  return (
    <section className={`cd-panel ${panel.type === "apdex" ? "cd-panel-stat" : ""}`}>
      <div className="cd-panel-head">
        <span className="cd-panel-title">{panel.title}</span>
        {editing && <button className="icon-btn sm" onClick={onRemove} aria-label="패널 삭제"><IconX /></button>}
      </div>
      {panel.type === "red" ? <RedPanel target={panel.target} />
        : panel.type === "apdex" ? <ApdexPanel target={panel.target} />
          : <ContainerPanel target={panel.target} />}
    </section>
  );
}

function AddPanel({ onAdd }: { onAdd: (p: Panel) => void }) {
  const [type, setType] = useState<Panel["type"]>("red");
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices });
  const { data: containers } = useQuery({ queryKey: ["containers"], queryFn: fetchContainers });
  const opts = type === "container" ? (containers ?? []).map((c) => c.container) : (services ?? []);
  const tgt = target || opts[0] || "";
  return (
    <form className="cd-add" onSubmit={(e) => { e.preventDefault(); if (!tgt) return; onAdd({ id: rid(), type, target: tgt, title: title || `${PANEL_TYPES.find((t) => t.id === type)?.label} · ${tgt}` }); setTitle(""); }}>
      <select className="select" value={type} onChange={(e) => { setType(e.target.value as Panel["type"]); setTarget(""); }} aria-label="패널 유형">
        {PANEL_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <select className="select" value={tgt} onChange={(e) => setTarget(e.target.value)} aria-label="대상">
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="패널 제목(선택)" aria-label="패널 제목" />
      <button type="submit" className="btn btn-primary">패널 추가</button>
    </form>
  );
}

export function CustomDash() {
  const qc = useQueryClient();
  const { auth } = useAuth();
  const canEdit = auth?.role !== "viewer";
  const { data: dashboards, isLoading } = useQuery({ queryKey: ["dashboards"], queryFn: fetchDashboards, refetchInterval: 20000 });
  const [editing, setEditing] = useState<Dashboard | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["dashboards"] });

  if (editing) {
    const panels = editing.spec.panels ?? [];
    const setPanels = (ps: Panel[]) => setEditing({ ...editing, spec: { panels: ps } });
    return (
      <div className="content-scroll">
        <div className="cd-view">
          <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
            <input className="input cd-name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label="대시보드 이름" />
            <div className="bar" style={{ marginLeft: "auto" }}>
              <button className="btn" onClick={() => setEditing(null)}>닫기</button>
              <button className="btn btn-primary" onClick={async () => { await saveDashboard({ id: editing.id, name: editing.name, spec: editing.spec }); invalidate(); setEditing(null); }}>저장</button>
            </div>
          </div>
          <AddPanel onAdd={(p) => setPanels([...panels, p])} />
          {panels.length === 0 ? (
            <EmptyState title="패널을 추가해보세요" body="RED 시계열·Apdex·컨테이너 CPU 패널을 조합해 나만의 대시보드를 만들어요." />
          ) : (
            <div className="cd-grid">
              {panels.map((p) => <PanelView key={p.id} panel={p} editing onRemove={() => setPanels(panels.filter((x) => x.id !== p.id))} />)}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="content-scroll">
      <div className="cd-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">커스텀 대시보드 {!canEdit && <span className="chip muted" style={{ marginLeft: 6 }}>읽기 전용</span>}</span>
          {canEdit && <button className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={() => setEditing({ id: "", name: "새 대시보드", spec: { panels: [] } })}>새 대시보드</button>}
        </div>
        {isLoading ? <Skeleton rows={4} /> : (dashboards ?? []).length === 0 ? (
          <EmptyState title="아직 대시보드가 없어요" body="RED·Apdex·컨테이너 패널을 조합해 팀·서비스별 관제 화면을 직접 만들어요." />
        ) : (
          <div className="cd-list">
            {(dashboards ?? []).map((d) => (
              <div key={d.id} className="cd-list-row">
                <button className="cd-list-open" onClick={() => setEditing(d)}>
                  <span className="cd-list-name">{d.name}</span>
                  <span className="cd-list-meta">{(d.spec.panels ?? []).length}개 패널</span>
                </button>
                <button className="icon-btn sm" onClick={async () => { await deleteDashboard(d.id); invalidate(); }} aria-label="대시보드 삭제"><IconX /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
