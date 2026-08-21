import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchServices, fetchAlertRules, createAlertRule, deleteAlertRule, fetchAlerts, upsertAlertRule,
  fetchChannels, createChannel, deleteChannel, testChannel, fetchNotifications,
} from "./api";
import type { AlertRule, Channel } from "./api";
import { EmptyState, Skeleton, IconX } from "./states";
import { useAuth } from "./auth";

const METRIC_LABEL: Record<string, string> = { error_rate: "에러율", p95_ms: "p95 지연", uptime: "가동", throughput: "처리량" };
const unitOf = (m: string) => (m === "p95_ms" ? "ms" : m === "throughput" ? "/분" : "%");
const CHAN_LABEL: Record<string, string> = { slack: "Slack", webhook: "Webhook", pagerduty: "PagerDuty" };
const CHAN_PLACEHOLDER: Record<string, string> = {
  slack: "https://hooks.slack.com/services/…",
  webhook: "https://your-endpoint.example.com/hook",
  pagerduty: "라우팅 키 (Integration Key)",
};

// ── Rules ────────────────────────────────────────────────────
function RuleForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices });
  const { data: channels } = useQuery({ queryKey: ["channels"], queryFn: fetchChannels });
  const [name, setName] = useState("");
  const [service, setService] = useState("");
  const [metric, setMetric] = useState<"error_rate" | "p95_ms">("error_rate");
  const [threshold, setThreshold] = useState(5);
  const [windowMin, setWindowMin] = useState(5);
  const [chans, setChans] = useState<Set<string>>(new Set());

  const create = useMutation({
    mutationFn: () => createAlertRule({ name, service: service || (services?.[0] ?? ""), metric, threshold, windowMin, enabled: true, channels: [...chans] }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["alert-rules"] }); onDone(); },
  });
  const svc = service || (services?.[0] ?? "");
  const enabledChannels = (channels ?? []).filter((c) => c.enabled);
  const toggleChan = (id: string) => setChans((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [err, setErr] = useState("");
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr("규칙 이름을 입력해주세요."); return; }
    if (!svc) { setErr("서비스를 선택해주세요."); return; }
    setErr(""); create.mutate();
  };

  return (
    <form className="rule-form" onSubmit={onSubmit}>
      <div className="onboard-row">
        <label className="onboard-field"><span className="field-label">규칙 이름</span>
          <input className="input" value={name} onChange={(e) => { setName(e.target.value); if (err) setErr(""); }} placeholder="예: 결제 에러율 급증" aria-label="규칙 이름" />
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
      <div className="rule-chan-pick">
        <span className="field-label">알림 채널</span>
        {enabledChannels.length === 0 ? (
          <p className="rule-chan-empty">아직 채널이 없어요. <b>채널</b> 탭에서 Slack·Webhook·PagerDuty를 추가하면 여기에 연결할 수 있어요. 지금은 환경 웹훅으로 발송돼요.</p>
        ) : (
          <div className="chan-checks">
            {enabledChannels.map((c) => (
              <label key={c.id} className={`chan-check${chans.has(c.id!) ? " on" : ""}`}>
                <input type="checkbox" checked={chans.has(c.id!)} onChange={() => toggleChan(c.id!)} />
                <span className="chan-check-name">{c.name}</span>
                <span className="chip muted chan-type">{CHAN_LABEL[c.type]}</span>
              </label>
            ))}
          </div>
        )}
        {enabledChannels.length > 0 && chans.size === 0 && <p className="rule-chan-note">선택 안 하면 환경 웹훅으로 발송돼요.</p>}
      </div>
      <div className="bar">
        <button type="submit" className="btn btn-primary" disabled={create.isPending || !name}>
          {create.isPending ? "만드는 중…" : "규칙 만들기"}
        </button>
        <button type="button" className="btn" onClick={onDone}>취소</button>
        {(err || create.isError) && <span className="form-err" role="alert">{err || "규칙을 저장하지 못했어요. 입력을 확인해주세요."}</span>}
      </div>
    </form>
  );
}

function RuleRow({ rule, channelsById }: { rule: AlertRule; channelsById: Map<string, Channel> }) {
  const qc = useQueryClient();
  const { auth } = useAuth();
  const canEdit = auth?.role !== "viewer";
  const invalidate = () => qc.invalidateQueries({ queryKey: ["alert-rules"] });
  const del = useMutation({ mutationFn: () => deleteAlertRule(rule.id!), onSuccess: invalidate });
  const toggle = useMutation({ mutationFn: () => upsertAlertRule({ ...rule, enabled: !rule.enabled }), onSuccess: invalidate });
  const chans = rule.channels ?? [];
  return (
    <tr className={rule.enabled ? "" : "rule-off"}>
      <td className="svc">{rule.name}</td>
      <td>{rule.service}</td>
      <td>{METRIC_LABEL[rule.metric] ?? rule.metric}</td>
      <td className="r">&gt; {rule.threshold} {unitOf(rule.metric)}</td>
      <td>
        {chans.length === 0 ? <span className="chip muted"><span className="dot" />환경 웹훅</span>
          : chans.map((id) => <span key={id} className="chip chan-pill">{channelsById.get(id)?.name ?? "삭제된 채널"}</span>)}
      </td>
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

// ── Channels ─────────────────────────────────────────────────
function ChannelForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [type, setType] = useState<Channel["type"]>("slack");
  const [target, setTarget] = useState("");
  const [err, setErr] = useState("");
  const create = useMutation({
    mutationFn: () => createChannel({ name, type, target, enabled: true }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["channels"] }); onDone(); },
  });
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr("채널 이름을 입력해주세요."); return; }
    if (!target.trim()) { setErr(type === "pagerduty" ? "라우팅 키를 입력해주세요." : "URL을 입력해주세요."); return; }
    setErr(""); create.mutate();
  };
  return (
    <form className="rule-form" onSubmit={onSubmit}>
      <div className="onboard-row">
        <label className="onboard-field"><span className="field-label">채널 이름</span>
          <input className="input" value={name} onChange={(e) => { setName(e.target.value); if (err) setErr(""); }} placeholder="예: #alerts-payments" aria-label="채널 이름" />
        </label>
        <label className="onboard-field"><span className="field-label">유형</span>
          <select className="select" value={type} onChange={(e) => setType(e.target.value as Channel["type"])}>
            <option value="slack">Slack</option>
            <option value="webhook">Webhook</option>
            <option value="pagerduty">PagerDuty</option>
          </select>
        </label>
      </div>
      <label className="onboard-field"><span className="field-label">{type === "pagerduty" ? "라우팅 키" : "URL"}</span>
        <input className="input" value={target} onChange={(e) => { setTarget(e.target.value); if (err) setErr(""); }} placeholder={CHAN_PLACEHOLDER[type]} aria-label="대상" spellCheck={false} />
      </label>
      <div className="bar">
        <button type="submit" className="btn btn-primary" disabled={create.isPending}>
          {create.isPending ? "추가 중…" : "채널 추가"}
        </button>
        <button type="button" className="btn" onClick={onDone}>취소</button>
        {(err || create.isError) && <span className="form-err" role="alert">{err || "채널을 저장하지 못했어요. 입력을 확인해주세요."}</span>}
      </div>
    </form>
  );
}

// Turn a raw Go transport error into something a human can act on.
function humanizeErr(e: string): string {
  if (/no such host|lookup/i.test(e)) return "대상을 찾을 수 없어요 — 호스트/URL을 확인해주세요";
  if (/refused/i.test(e)) return "연결이 거부됐어요 — URL·포트를 확인해주세요";
  if (/timeout|deadline/i.test(e)) return "응답 시간이 초과됐어요";
  const http = e.match(/HTTP (\d{3})/);
  if (http) return `대상이 ${http[1]} 응답을 반환했어요`;
  return e.length > 90 ? e.slice(0, 90) + "…" : e;
}

function ChannelRow({ ch, canEdit }: { ch: Channel; canEdit: boolean }) {
  const qc = useQueryClient();
  const del = useMutation({ mutationFn: () => deleteChannel(ch.id!), onSuccess: () => qc.invalidateQueries({ queryKey: ["channels"] }) });
  const [test, setTest] = useState<"idle" | "sending" | "ok" | "fail">("idle");
  const [testErr, setTestErr] = useState("");
  const runTest = async () => {
    setTest("sending"); setTestErr("");
    const err = await testChannel(ch.id!);
    if (err) {
      setTest("fail"); setTestErr(humanizeErr(err)); // failures persist until the next test — not auto-dismissed
    } else {
      setTest("ok"); setTimeout(() => setTest("idle"), 3000);
    }
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  return (
    <tr>
      <td className="svc">{ch.name}</td>
      <td><span className="chip muted"><span className="dot" />{CHAN_LABEL[ch.type]}</span></td>
      <td className="chan-target" title={ch.target}>{ch.target}</td>
      <td className="r">
        {canEdit && <button className="btn btn-sm" onClick={runTest} disabled={test === "sending"}>
          {test === "sending" ? "전송 중…" : test === "ok" ? "전송됨 ✓" : test === "fail" ? "다시 시도" : "테스트"}
        </button>}
        {test === "fail" && <span className="chan-test-err" role="alert">{testErr}</span>}
      </td>
      <td>{canEdit && <button className="icon-btn sm" onClick={() => del.mutate()} aria-label="채널 삭제" title="삭제"><IconX /></button>}</td>
    </tr>
  );
}

// ── View ─────────────────────────────────────────────────────
const TABS = [{ id: "rules", label: "규칙" }, { id: "channels", label: "채널" }, { id: "log", label: "발송 기록" }];

export function Alerts() {
  const [tab, setTab] = useState("rules");
  const [adding, setAdding] = useState(false);
  const [addingChan, setAddingChan] = useState(false);
  const { auth } = useAuth();
  const canEdit = auth?.role !== "viewer";
  const { data: rules, isLoading: rulesLoading } = useQuery({ queryKey: ["alert-rules"], queryFn: fetchAlertRules, refetchInterval: 10000 });
  const { data: channels } = useQuery({ queryKey: ["channels"], queryFn: fetchChannels, refetchInterval: 30000 });
  const { data: alerts } = useQuery({ queryKey: ["alerts"], queryFn: fetchAlerts, refetchInterval: 5000 });
  const { data: notifs } = useQuery({ queryKey: ["notifications"], queryFn: fetchNotifications, refetchInterval: 10000, enabled: tab === "log" });
  const channelsById = new Map((channels ?? []).map((c) => [c.id!, c]));

  return (
    <div className="content-scroll">
      <div className="alerts-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">알림 {!canEdit && <span className="chip muted" style={{ marginLeft: 6 }}>읽기 전용</span>}</span>
          <div className="segmented" role="tablist" aria-label="알림 보기" style={{ marginLeft: "auto" }}>
            {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className="seg" onClick={() => setTab(t.id)}>{t.label}</button>)}
          </div>
        </div>

        {tab === "rules" && (
          <>
            <div className="bar" style={{ marginBottom: "var(--sp-3)" }}>
              {canEdit && !adding && <button className="btn btn-primary" onClick={() => setAdding(true)}>규칙 추가</button>}
            </div>
            {adding && <RuleForm onDone={() => setAdding(false)} />}
            {rulesLoading ? <Skeleton rows={4} />
              : (rules ?? []).length === 0 && !adding ? (
                <EmptyState title="아직 알림 규칙이 없어요" body="서비스의 에러율이나 p95 지연이 임계값을 넘으면 알려드릴게요. 첫 규칙을 만들어보세요."
                  action={canEdit ? <button className="btn btn-primary" onClick={() => setAdding(true)}>첫 규칙 만들기</button> : undefined} />
              ) : (rules ?? []).length > 0 ? (
                <table className="tbl">
                  <thead><tr><th>규칙</th><th>서비스</th><th>지표</th><th className="r">조건</th><th>채널</th><th>사용</th><th></th></tr></thead>
                  <tbody>{(rules ?? []).map((r) => <RuleRow key={r.id} rule={r} channelsById={channelsById} />)}</tbody>
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
                    <span className="log-body">{a.service} · {METRIC_LABEL[a.metric] ?? a.metric} {a.value.toFixed(1)}{unitOf(a.metric)}<span className="alert-thr"> (임계 {a.threshold}{unitOf(a.metric)})</span></span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "channels" && (
          <>
            <p className="chan-intro">알림이 발화하면 여기 등록한 채널로 전송돼요. 규칙마다 채널을 골라 라우팅하고, 지정 안 한 규칙은 환경 웹훅으로 갑니다.</p>
            <div className="bar" style={{ marginBottom: "var(--sp-3)" }}>
              {canEdit && !addingChan && <button className="btn btn-primary" onClick={() => setAddingChan(true)}>채널 추가</button>}
            </div>
            {addingChan && <ChannelForm onDone={() => setAddingChan(false)} />}
            {(channels ?? []).length === 0 && !addingChan ? (
              <EmptyState title="아직 채널이 없어요" body="Slack 수신 웹훅, 범용 Webhook, 또는 PagerDuty 라우팅 키를 추가하면 알림을 사람에게 보낼 수 있어요."
                action={canEdit ? <button className="btn btn-primary" onClick={() => setAddingChan(true)}>첫 채널 추가하기</button> : undefined} />
            ) : (channels ?? []).length > 0 ? (
              <table className="tbl">
                <thead><tr><th>채널</th><th>유형</th><th>대상</th><th className="r">테스트</th><th></th></tr></thead>
                <tbody>{(channels ?? []).map((c) => <ChannelRow key={c.id} ch={c} canEdit={canEdit} />)}</tbody>
              </table>
            ) : null}
          </>
        )}

        {tab === "log" && (
          <>
            <p className="chan-intro">각 발화가 어떤 채널로, 성공/실패로 전송됐는지 기록이에요. 최근 100건.</p>
            {(notifs ?? []).length === 0 ? (
              <div className="log-empty">아직 발송 기록이 없어요. 알림이 발화하거나 채널을 테스트하면 여기에 남아요.</div>
            ) : (
              <div className="loglist">
                {(notifs ?? []).map((n, i) => (
                  <div key={i} className="logrow alert-row">
                    <span className="log-time">{n.ts.slice(0, 19).replace("T", " ")}</span>
                    <span className={`chip ${n.ok ? "ok" : "err"} log-sev`}><span className="dot" />{n.ok ? "성공" : "실패"}</span>
                    <span className="log-svc">{n.channelName} <span className="chip muted chan-type">{CHAN_LABEL[n.type] ?? n.type}</span></span>
                    <span className="log-body">{n.ruleName}{n.error && <span className="alert-thr"> · {n.error}</span>}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
