import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchServices, fetchAlertRules, createAlertRule, deleteAlertRule, fetchAlerts, upsertAlertRule,
  fetchChannels, createChannel, deleteChannel, testChannel, fetchNotifications, fetchSpanQuery, fetchLogQuery,
} from "./api";
import type { AlertRule, AlertMetric, Channel, Alert } from "./api";
import { EmptyState, Skeleton, IconX } from "./states";
import { useAuth } from "./auth";
import { useNav } from "./nav";
import { IncidentModal, fmtMetric } from "./IncidentModal";
import { getParam, replaceParams } from "./urlState";

const METRIC_LABEL: Record<string, string> = { error_rate: "에러율", p95_ms: "p95 지연", error_count: "에러 건수", log_match: "로그 매칭", span_match: "스팬 매칭", uptime: "가동", throughput: "처리량" };
const unitOf = (m: string) => (m === "p95_ms" ? "ms" : m === "throughput" ? "/분" : m === "error_count" || m === "log_match" || m === "span_match" ? "건" : "%");
const CHAN_LABEL: Record<string, string> = { slack: "Slack", webhook: "Webhook", pagerduty: "PagerDuty" };
const CHAN_PLACEHOLDER: Record<string, string> = {
  slack: "https://hooks.slack.com/services/…",
  webhook: "https://your-endpoint.example.com/hook",
  pagerduty: "라우팅 키 (Integration Key)",
};

// ── Rules ────────────────────────────────────────────────────
function RuleForm({ onDone, initMetric, initQuery }: { onDone: () => void; initMetric?: AlertMetric; initQuery?: string }) {
  const qc = useQueryClient();
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices });
  const { data: channels } = useQuery({ queryKey: ["channels"], queryFn: fetchChannels });
  const [name, setName] = useState("");
  const [service, setService] = useState("");
  const [metric, setMetric] = useState<AlertMetric>(initMetric ?? "error_rate");
  const [threshold, setThreshold] = useState(5);
  const [windowMin, setWindowMin] = useState(5);
  const [query, setQuery] = useState(initQuery ?? "");
  const [chans, setChans] = useState<Set<string>>(new Set());
  const isQuery = metric === "log_match" || metric === "span_match";
  const qPlaceholder = metric === "span_match" ? `service = "PaymentService" AND duration > 2s` : `severity = error AND body ~ "OutOfMemory"`;
  const qLabel = metric === "span_match" ? "스팬 쿼리 (DSL · 매칭 건수)" : "로그 쿼리 (DSL · 매칭 건수)";

  const create = useMutation({
    mutationFn: () => createAlertRule({ name, service: isQuery ? "" : (service || (services?.[0] ?? "")), metric, threshold, windowMin, enabled: true, channels: [...chans], query: isQuery ? query : "" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["alert-rules"] }); onDone(); },
  });
  const svc = service || (services?.[0] ?? "");
  const enabledChannels = (channels ?? []).filter((c) => c.enabled);
  const toggleChan = (id: string) => setChans((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [err, setErr] = useState("");
  const [invalid, setInvalid] = useState<"" | "name" | "query" | "service">("");
  const nameRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr("규칙 이름을 입력해주세요."); setInvalid("name"); nameRef.current?.focus(); return; }
    if (isQuery) { if (!query.trim()) { setErr("쿼리를 입력해주세요. 예: " + qPlaceholder); setInvalid("query"); queryRef.current?.focus(); return; } }
    else if (!svc) { setErr("서비스를 선택해주세요."); setInvalid("service"); return; }
    setErr(""); setInvalid(""); create.mutate();
  };
  // Human-readable summary so "5분간 87건" reads as one condition, not two fields.
  const previewTarget = isQuery ? `${metric === "span_match" ? "스팬" : "로그"} «${query || "쿼리"}» 매칭 건수` : `${svc}의 ${METRIC_LABEL[metric]}`;

  // Query rules: show how many the condition matches right now, so the threshold
  // isn't set blind. Uses the same DSL over the alert's window.
  const { data: matchNow } = useQuery({
    queryKey: ["rule-match", metric, query, windowMin],
    enabled: isQuery && query.trim() !== "",
    retry: false,
    queryFn: async () => {
      const from = new Date(Date.now() - windowMin * 60000).toISOString();
      const to = new Date().toISOString();
      const dsl = `${query} | stats count by service`;
      const res = metric === "span_match" ? await fetchSpanQuery(dsl, from, to) : await fetchLogQuery(dsl, from, to);
      return res.kind === "facets" ? res.rows.reduce((a, r) => a + (r.values[0] ?? 0), 0) : 0;
    },
  });

  // Prefilled from Explore → focus the one field left to fill (the name).
  useEffect(() => { if (initQuery) nameRef.current?.focus(); }, []); // eslint-disable-line

  return (
    <form className="rule-form" onSubmit={onSubmit}>
      {initQuery && <p className="rule-promote-banner">탐색에서 가져온 쿼리로 규칙을 만들어요. <b>이름만 정하면 끝</b>이에요.</p>}
      <div className="onboard-row">
        <label className="onboard-field"><span className="field-label">규칙 이름</span>
          <input ref={nameRef} className="input" value={name} onChange={(e) => { setName(e.target.value); if (err) { setErr(""); setInvalid(""); } }} placeholder={initQuery ? "예: 느린 결제 스팬 급증" : "예: 결제 에러율 급증"} aria-label="규칙 이름" aria-invalid={invalid === "name" || undefined} aria-describedby={err ? "rule-err" : undefined} />
        </label>
        <label className="onboard-field"><span className="field-label">지표</span>
          <select className="select" value={metric} onChange={(e) => setMetric(e.target.value as AlertMetric)}>
            <option value="error_rate">에러율 (%)</option>
            <option value="p95_ms">p95 지연 (ms)</option>
            <option value="error_count">에러 건수 (건)</option>
            <option value="log_match">로그 매칭 (건)</option>
            <option value="span_match">스팬 매칭 (건)</option>
          </select>
        </label>
      </div>
      <div className="onboard-row">
        <div style={{ display: "contents" }} aria-live="polite">
          {isQuery ? (
            <label className="onboard-field" style={{ flex: "1 1 100%" }}><span className="field-label">{qLabel}</span>
              <input ref={queryRef} className="input rule-query-input" value={query} onChange={(e) => { setQuery(e.target.value); if (err) { setErr(""); setInvalid(""); } }} placeholder={qPlaceholder} aria-label={qLabel} aria-invalid={invalid === "query" || undefined} aria-describedby={err ? "rule-err" : undefined} spellCheck={false} />
            </label>
          ) : (
            <label className="onboard-field"><span className="field-label">서비스</span>
              <select className="select" value={svc} onChange={(e) => setService(e.target.value)}>
                {(services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          )}
        </div>
        <label className="onboard-field"><span className="field-label">임계값 초과 시 발화 ({unitOf(metric)})</span>
          <input className="input" type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} min={0} step={isQuery || metric === "error_count" ? 1 : "any"} aria-label="임계값" />
        </label>
        <label className="onboard-field"><span className="field-label">관측 구간</span>
          <select className="select" value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))}>
            <option value={5}>최근 5분</option>
            <option value={10}>최근 10분</option>
            <option value={30}>최근 30분</option>
          </select>
        </label>
      </div>
      <p className="rule-preview">최근 {windowMin}분간 {previewTarget} &gt; {threshold}{unitOf(metric)} 이면 발화해요{isQuery && matchNow !== undefined && <span className="rule-match-now"> · 지금은 최근 {windowMin}분간 <b>{matchNow.toLocaleString()}건</b> 매칭 중</span>}</p>
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
        <button type="submit" className="btn btn-primary" disabled={create.isPending}>
          {create.isPending ? "만드는 중…" : "규칙 만들기"}
        </button>
        <button type="button" className="btn" onClick={onDone}>취소</button>
        {(err || create.isError) && <span id="rule-err" className="form-err" role="alert">{err || "규칙을 저장하지 못했어요. 입력을 확인해주세요."}</span>}
      </div>
    </form>
  );
}

const SNOOZE_OPTS = [{ label: "30분", min: 30 }, { label: "1시간", min: 60 }, { label: "4시간", min: 240 }, { label: "내일까지", min: 60 * 24 }];
function snoozeRemaining(iso?: string): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "";
  const m = Math.round(ms / 60000);
  return m >= 60 ? `약 ${Math.ceil(m / 60)}시간` : `${m}분`;
}

// Temporarily silence a rule's notifications (maintenance window) without losing
// its config — distinct from disabling, which stops evaluation entirely.
function SnoozeControl({ rule, canEdit }: { rule: AlertRule; canEdit: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["alert-rules"] });
  const m = useMutation({
    mutationFn: (snoozeUntil: string) => upsertAlertRule({ ...rule, snoozeUntil }),
    onSuccess: () => { invalidate(); setOpen(false); },
  });
  // Menu contract: focus first option on open; close on outside-click or Esc.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(".snooze-opt")?.focus();
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const opts = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(".snooze-opt") ?? []);
    const i = opts.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); opts[Math.min(i + 1, opts.length - 1)]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); opts[Math.max(i - 1, 0)]?.focus(); }
  };
  const remaining = snoozeRemaining(rule.snoozeUntil);
  if (!canEdit) return remaining ? <span className="chip muted" title="무음 중"><span aria-hidden>🔕</span> {remaining}</span> : null;
  if (remaining) {
    return <button className="btn btn-sm snooze-active" onClick={() => m.mutate("")} title="무음 해제" disabled={m.isPending} aria-label={`무음 ${remaining} 남음 — 해제`}><span aria-hidden>🔕</span> {remaining} · 해제</button>;
  }
  return (
    <div className="snooze-wrap" ref={wrapRef}>
      <button className="btn btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">무음<span aria-hidden> ▾</span></button>
      {open && (
        <div className="snooze-menu" role="menu" ref={menuRef} onKeyDown={onMenuKey}>
          {SNOOZE_OPTS.map((o) => (
            <button key={o.min} role="menuitem" className="snooze-opt" disabled={m.isPending}
              onClick={() => m.mutate(new Date(Date.now() + o.min * 60000).toISOString())}>{o.label}</button>
          ))}
        </div>
      )}
      {m.isError && <span className="chan-test-err" role="alert">무음 실패 · 다시 시도</span>}
    </div>
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
  const snoozed = !!rule.snoozeUntil && new Date(rule.snoozeUntil).getTime() > Date.now();
  return (
    <tr className={`${rule.enabled ? "" : "rule-off"}${snoozed ? " rule-snoozed" : ""}`}>
      <td className="svc">{rule.name}</td>
      <td data-label="대상">{rule.metric === "log_match" || rule.metric === "span_match" ? <code className="rule-query" title={rule.query}>{rule.query}</code> : rule.service}</td>
      <td data-label="지표">{METRIC_LABEL[rule.metric] ?? rule.metric}</td>
      <td className="r" data-label="조건">&gt; {rule.threshold} {unitOf(rule.metric)}</td>
      <td data-label="채널">
        {chans.length === 0 ? <span className="chip muted"><span className="dot" />환경 웹훅</span>
          : chans.map((id) => <span key={id} className="chip chan-pill">{channelsById.get(id)?.name ?? "삭제된 채널"}</span>)}
      </td>
      <td data-label="무음"><SnoozeControl rule={rule} canEdit={canEdit} /></td>
      <td data-label="사용">
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
  // A span query promoted from Explore arrives as ?newalert=<dsl> → open the rule
  // form pre-filled as a span_match rule.
  const promotedQuery = getParam("newalert");
  const [tab, setTab] = useState("rules");
  const [adding, setAdding] = useState(!!promotedQuery);
  const [addingChan, setAddingChan] = useState(false);
  const closeAdd = () => { setAdding(false); if (getParam("newalert")) replaceParams({ newalert: null }); };
  const { auth } = useAuth();
  const { openTrace } = useNav();
  const [incident, setIncident] = useState<Alert | null>(null);
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
            {adding && <RuleForm onDone={closeAdd} initMetric={promotedQuery ? "span_match" : undefined} initQuery={promotedQuery ?? undefined} />}
            {rulesLoading ? <Skeleton rows={4} />
              : (rules ?? []).length === 0 && !adding ? (
                <EmptyState title="아직 알림 규칙이 없어요" body="서비스의 에러율이나 p95 지연이 임계값을 넘으면 알려드릴게요. 첫 규칙을 만들어보세요."
                  action={canEdit ? <button className="btn btn-primary" onClick={() => setAdding(true)}>첫 규칙 만들기</button> : undefined} />
              ) : (rules ?? []).length > 0 ? (
                <table className="tbl">
                  <thead><tr><th>규칙</th><th>대상</th><th>지표</th><th className="r">조건</th><th>채널</th><th>무음</th><th>사용</th><th></th></tr></thead>
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
                    <span className="log-body">{a.service} · {METRIC_LABEL[a.metric] ?? a.metric} {fmtMetric(a.metric, a.value)}<span className="alert-thr"> (임계 {fmtMetric(a.metric, a.threshold)})</span></span>
                    {a.service && <button className="btn-investigate" onClick={() => setIncident(a)} aria-label={`${a.ruleName} 인시던트 조사`}>조사하기 →</button>}
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
      {incident && <IncidentModal alert={incident} onClose={() => setIncident(null)} onTrace={(t) => { setIncident(null); openTrace(t); }} />}
    </div>
  );
}
