import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchServices, fetchAlertRules, createAlertRule, deleteAlertRule, fetchAlerts, upsertAlertRule } from "./api";
import type { AlertRule } from "./api";
import { EmptyState, Skeleton, IconX } from "./states";
import { useAuth } from "./auth";

const METRIC_LABEL: Record<string, string> = { error_rate: "에러율", p95_ms: "p95 지연", uptime: "가동", throughput: "처리량" };
const unitOf = (m: string) => (m === "p95_ms" ? "ms" : m === "throughput" ? "/분" : "%");

function RuleForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices });
  const [name, setName] = useState("");
  const [service, setService] = useState("");
  const [metric, setMetric] = useState<"error_rate" | "p95_ms">("error_rate");
  const [threshold, setThreshold] = useState(5);
  const [windowMin, setWindowMin] = useState(5);

  const create = useMutation({
    mutationFn: () => createAlertRule({ name, service: service || (services?.[0] ?? ""), metric, threshold, windowMin, enabled: true }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["alert-rules"] }); onDone(); },
  });

  const svc = service || (services?.[0] ?? "");
  return (
    <form className="rule-form" onSubmit={(e) => { e.preventDefault(); if (name && svc) create.mutate(); }}>
      <div className="onboard-row">
        <label className="onboard-field"><span className="field-label">규칙 이름</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 결제 에러율 급증" aria-label="규칙 이름" required />
        </label>
        <label className="onboard-field"><span className="field-label">서비스</span>
          <select className="select" value={svc} onChange={(e) => setService(e.target.value)}>
            {(services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <div className="onboard-row">
        <label className="onboard-field"><span className="field-label">지표</span>
          <select className="select" value={metric} onChange={(e) => setMetric(e.target.value as "error_rate" | "p95_ms")}>
            <option value="error_rate">에러율 (%)</option>
            <option value="p95_ms">p95 지연 (ms)</option>
          </select>
        </label>
        <label className="onboard-field"><span className="field-label">임계값 초과 시 발화 ({unitOf(metric)})</span>
          <input className="input" type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} min={0} step="any" aria-label="임계값" />
        </label>
        <label className="onboard-field"><span className="field-label">관측 구간</span>
          <select className="select" value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))}>
            <option value={5}>최근 5분</option>
            <option value={10}>최근 10분</option>
            <option value={30}>최근 30분</option>
          </select>
        </label>
      </div>
      <div className="bar">
        <button type="submit" className="btn btn-primary" disabled={create.isPending || !name}>
          {create.isPending ? "만드는 중…" : "규칙 만들기"}
        </button>
        <button type="button" className="btn" onClick={onDone}>취소</button>
        {create.isError && <span className="form-err">규칙을 저장하지 못했어요. 입력을 확인해주세요.</span>}
      </div>
    </form>
  );
}

function RuleRow({ rule }: { rule: AlertRule }) {
  const qc = useQueryClient();
  const { auth } = useAuth();
  const canEdit = auth?.role !== "viewer";
  const invalidate = () => qc.invalidateQueries({ queryKey: ["alert-rules"] });
  const del = useMutation({ mutationFn: () => deleteAlertRule(rule.id!), onSuccess: invalidate });
  const toggle = useMutation({ mutationFn: () => upsertAlertRule({ ...rule, enabled: !rule.enabled }), onSuccess: invalidate });
  return (
    <tr className={rule.enabled ? "" : "rule-off"}>
      <td className="svc">{rule.name}</td>
      <td>{rule.service}</td>
      <td>{METRIC_LABEL[rule.metric] ?? rule.metric}</td>
      <td className="r">&gt; {rule.threshold} {unitOf(rule.metric)}</td>
      <td>최근 {rule.windowMin}분</td>
      <td>
        <button className={`toggle ${rule.enabled ? "on" : ""}`} role="switch" aria-checked={rule.enabled}
          onClick={() => toggle.mutate()} disabled={toggle.isPending || !canEdit}
          aria-label={rule.enabled ? "규칙 끄기" : "규칙 켜기"} title={rule.enabled ? "켜짐 — 클릭해 일시중지" : "꺼짐 — 클릭해 활성화"}>
          <span className="toggle-knob" />
        </button>
      </td>
      <td>
        {canEdit && <button className="icon-btn sm" onClick={() => del.mutate()} aria-label="규칙 삭제" title="삭제"><IconX /></button>}
      </td>
    </tr>
  );
}

export function Alerts() {
  const [adding, setAdding] = useState(false);
  const { auth } = useAuth();
  const canEdit = auth?.role !== "viewer";
  const { data: rules, isLoading: rulesLoading } = useQuery({ queryKey: ["alert-rules"], queryFn: fetchAlertRules, refetchInterval: 10000 });
  const { data: alerts } = useQuery({ queryKey: ["alerts"], queryFn: fetchAlerts, refetchInterval: 5000 });

  return (
    <div className="content-scroll">
      <div className="alerts-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">알림 규칙 {!canEdit && <span className="chip muted" style={{ marginLeft: 6 }}>읽기 전용</span>}</span>
          {canEdit && !adding && <button className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)}>규칙 추가</button>}
        </div>

        {adding && <RuleForm onDone={() => setAdding(false)} />}

        {rulesLoading ? (
          <Skeleton rows={4} />
        ) : (rules ?? []).length === 0 && !adding ? (
          <EmptyState
            title="아직 알림 규칙이 없어요"
            body="서비스의 에러율이나 p95 지연이 임계값을 넘으면 알려드릴게요. 첫 규칙을 만들어보세요."
          />
        ) : (rules ?? []).length > 0 ? (
          <table className="tbl">
            <thead><tr><th>규칙</th><th>서비스</th><th>지표</th><th className="r">조건</th><th>구간</th><th>사용</th><th></th></tr></thead>
            <tbody>{(rules ?? []).map((r) => <RuleRow key={r.id} rule={r} />)}</tbody>
          </table>
        ) : null}

        <div className="section-label" style={{ marginTop: "var(--sp-5)" }}>발화 이력</div>
        {(alerts ?? []).length === 0 ? (
          <div className="log-empty">아직 발화된 알림이 없어요. 규칙 조건이 충족되면 여기에 기록돼요.</div>
        ) : (
          <div className="loglist">
            {(alerts ?? []).map((a, i) => (
              <div key={i} className="logrow alert-row">
                <span className="log-time">{a.firedAt.slice(0, 19).replace("T", " ")}</span>
                <span className={`chip ${a.state === "firing" ? "err" : "ok"} log-sev`}><span className="dot" />{a.state === "firing" ? "발화" : "해제"}</span>
                <span className="log-svc">{a.ruleName}</span>
                <span className="log-body">
                  {a.service} · {METRIC_LABEL[a.metric] ?? a.metric} {a.value.toFixed(1)}{unitOf(a.metric)}
                  <span className="alert-thr"> (임계 {a.threshold}{unitOf(a.metric)})</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
