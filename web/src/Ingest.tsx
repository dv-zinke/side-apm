import { useState } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { fetchSamplingRules, createSamplingRule, deleteSamplingRule, fetchIngestStats, fetchServices } from "./api";
import type { SamplingRule } from "./api";
import { EmptyState, Skeleton, ErrorState, IconX } from "./states";
import { useAuth } from "./auth";
import { useTheme } from "./theme";
import { chartColors } from "./chart";
import { TimeRangePicker, resolveSel, selLabel, useTimeSel } from "./range";

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

function RuleForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices });
  const [service, setService] = useState("*");
  const [keep, setKeep] = useState(20);
  const create = useMutation({
    mutationFn: () => createSamplingRule({ service, keepRate: keep / 100, enabled: true }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sampling-rules"] }); onDone(); },
  });
  return (
    <form className="rule-form" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <div className="onboard-row">
        <label className="onboard-field"><span className="field-label">서비스</span>
          <select className="select" value={service} onChange={(e) => setService(e.target.value)}>
            <option value="*">전체 기본값 (*)</option>
            {(services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="onboard-field"><span className="field-label">보관 비율 · {keep}%</span>
          <input className="ingest-slider" type="range" min={0} max={100} step={5} value={keep} onChange={(e) => setKeep(Number(e.target.value))} aria-label="보관 비율" />
        </label>
      </div>
      <p className="rule-preview">일반 스팬의 <b>{keep}%</b>만 보관해요. 에러·느린 스팬(&gt;1초)은 이 비율과 무관하게 <b>항상 보관</b>합니다.</p>
      <div className="bar">
        <button type="submit" className="btn btn-primary" disabled={create.isPending}>{create.isPending ? "저장 중…" : "규칙 저장"}</button>
        <button type="button" className="btn" onClick={onDone}>취소</button>
        {create.isError && <span className="form-err" role="alert">규칙을 저장하지 못했어요. 네트워크를 확인하고 <button type="button" className="q-retry" onClick={() => create.mutate()}>다시 시도</button>해주세요.</span>}
      </div>
    </form>
  );
}

function RuleRow({ rule, canEdit, onDeleted }: { rule: SamplingRule; canEdit: boolean; onDeleted: (r: SamplingRule) => void }) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => deleteSamplingRule(rule.id!),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sampling-rules"] }); onDeleted(rule); },
  });
  return (
    <tr>
      <td data-label="서비스" className="svc">{rule.service === "*" ? "전체 기본값 *" : rule.service}</td>
      <td data-label="보관 비율" className="r ingest-rate">{pct(rule.keepRate)}</td>
      <td data-label="상태">{rule.enabled ? <span className="chip ok"><span className="dot" />활성</span> : <span className="chip muted"><span className="dot" />꺼짐</span>}</td>
      <td>{canEdit && <button className="icon-btn sm" onClick={() => del.mutate()} aria-label="규칙 삭제" title="삭제"><IconX /></button>}</td>
    </tr>
  );
}

export function Ingest() {
  const { auth } = useAuth();
  const canEdit = auth?.role !== "viewer";
  const { theme } = useTheme();
  const c = chartColors(theme);
  const [adding, setAdding] = useState(false);
  const [undo, setUndo] = useState<SamplingRule | null>(null);
  const [sel, setSel] = useTimeSel();
  const qc = useQueryClient();
  const minute = Math.floor(Date.now() / 60000);
  const w = resolveSel(sel, minute * 60000);
  const { data: rules, isLoading: rulesLoading } = useQuery({ queryKey: ["sampling-rules"], queryFn: fetchSamplingRules, refetchInterval: 15000 });
  const { data: stats, isLoading: statsLoading, isError: statsError, refetch: statsRefetch } = useQuery({
    queryKey: ["ingest-stats", w.fromISO, w.toISO], queryFn: () => fetchIngestStats(w.fromISO, w.toISO),
    refetchInterval: w.live ? 15000 : false, placeholderData: keepPreviousData,
  });
  const onDeleted = (r: SamplingRule) => { setUndo(r); setTimeout(() => setUndo((u) => (u === r ? null : u)), 8000); };
  const doUndo = async () => { const r = undo; setUndo(null); if (r) { await createSamplingRule({ service: r.service, keepRate: r.keepRate, enabled: r.enabled }); qc.invalidateQueries({ queryKey: ["sampling-rules"] }); } };
  const s = stats ?? [];
  const totRecv = s.reduce((a, x) => a + x.received, 0);
  const totKept = s.reduce((a, x) => a + x.kept, 0);
  const totDrop = totRecv - totKept;
  const savings = totRecv > 0 ? totDrop / totRecv : 0;
  const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const option = {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
    legend: { data: ["보관", "드롭"], textStyle: { color: c.legend }, top: 0, icon: "roundRect" },
    grid: { left: 48, right: 16, top: 30, bottom: 26 },
    xAxis: { type: "category", data: s.map((x) => hm(x.minute)), axisLabel: { color: c.axis, hideOverlap: true }, axisLine: { lineStyle: { color: c.split } } },
    yAxis: { type: "value", axisLabel: { color: c.axis }, splitLine: { lineStyle: { color: c.split } } },
    series: [
      { name: "보관", type: "bar", stack: "v", data: s.map((x) => x.kept), color: c.accent },
      { name: "드롭", type: "bar", stack: "v", data: s.map((x) => x.dropped), color: theme === "dark" ? "#454b54" : "#b4b8c0" },
    ],
  };

  return (
    <div className="content-scroll">
      <div className="alerts-view ingest-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">인입 제어 · 샘플링 <span className="hint-inline">저장 비용을 규칙으로 제어</span></span>
          <div style={{ marginLeft: "auto" }}><TimeRangePicker value={sel} onChange={setSel} /></div>
        </div>

        <p className="chan-intro">스팬 인입에 보관 규칙을 적용해 저장량을 줄여요. <b>에러·느린 스팬(&gt;1초)은 항상 보관</b>하므로 문제는 놓치지 않아요. 규칙이 없으면 전량 보관(기본).</p>

        {/* Ingest volume + savings */}
        {statsError && !stats ? (
          <ErrorState error={new Error("인입 통계를 불러오지 못했어요")} onRetry={() => statsRefetch()} />
        ) : statsLoading && !stats ? (
          <Skeleton rows={6} />
        ) : (
          <>
            <div className="ingest-kpis" aria-live="polite">
              <div className="kpi-card"><div className="kpi-label">수신 · {selLabel(sel)}</div><div className="kpi-value">{totRecv.toLocaleString()}</div></div>
              <div className="kpi-card"><div className="kpi-label">보관</div><div className="kpi-value ok">{totKept.toLocaleString()}</div></div>
              <div className="kpi-card"><div className="kpi-label" title="에러·느린 스팬은 항상 보관하므로 설정 비율보다 실제 보관율이 높아요.">저장 절감</div><div className={`kpi-value${savings > 0 ? " ok" : ""}`}>{(savings * 100).toFixed(0)}<span className="kpi-unit">%</span></div></div>
            </div>
            {s.length === 0 ? (
              <div className="log-empty">이 기간에 인입 통계가 없어요. 트래픽이 흐르면 수신·보관·드롭이 분당 집계돼요.</div>
            ) : (
              <div style={{ height: 200, marginBottom: "var(--sp-4)" }}><ReactECharts option={option} style={{ height: "100%" }} notMerge /></div>
            )}
          </>
        )}

        {undo && (
          <div className="ingest-undo" role="status">
            <span>규칙을 삭제했어요.</span>
            <button className="btn btn-sm" onClick={doUndo}>되돌리기</button>
          </div>
        )}

        <div className="section-label">샘플링 규칙 {canEdit && !adding && <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)}>규칙 추가</button>}</div>
        {adding && <RuleForm onDone={() => setAdding(false)} />}
        {rulesLoading ? <Skeleton rows={3} />
          : (rules ?? []).length === 0 && !adding ? (
            <EmptyState title="샘플링 규칙이 없어요 (전량 보관 중)" body="서비스별 보관 비율을 정하면 저장량을 줄일 수 있어요. 전체 기본값(*)부터 시작해보세요."
              action={canEdit ? <button className="btn btn-primary" onClick={() => setAdding(true)}>규칙 추가하기</button> : undefined} />
          ) : (rules ?? []).length > 0 ? (
            <table className="tbl">
              <thead><tr><th>서비스</th><th className="r">보관 비율</th><th>상태</th><th></th></tr></thead>
              <tbody>{(rules ?? []).map((r) => <RuleRow key={r.id} rule={r} canEdit={canEdit} onDeleted={onDeleted} />)}</tbody>
            </table>
          ) : null}
      </div>
    </div>
  );
}
