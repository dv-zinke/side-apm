import { useState } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { fetchErrorGroups, fetchErrorDetail, setErrorStatus } from "./api";
import type { ErrorGroup, Transaction } from "./api";
import { EmptyState, Skeleton, ErrorState, IconX } from "./states";
import { useTheme } from "./theme";
import { chartColors } from "./chart";
import { useNav } from "./nav";
import { TimeRangePicker, StreamStatus, resolveSel, selLabel, useTimeSel } from "./range";
import { getParam, replaceParams } from "./urlState";

// Relative "…전" so operators scan recency at a glance.
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
// Bucket size that keeps the trend chart around ~40 bars for any window.
function stepFor(fromISO: string, toISO: string): number {
  const min = (new Date(toISO).getTime() - new Date(fromISO).getTime()) / 60000;
  return Math.max(1, Math.min(1440, Math.round(min / 40)));
}
function typeTone(t: string): string {
  if (t.startsWith("HTTP 4")) return "warn";
  return "err"; // 5xx, HTTP 0 (connection failure), and named exceptions
}

// Humanize the raw error type. "HTTP 0" means there was no HTTP status (a DB/driver
// or non-HTTP span) — showing it verbatim misleads users into reading a status code.
function humanType(t: string, op?: string): string {
  if (t === "HTTP 0" || t === "HTTP") return /\b(sql|db|query|conn|pg|postgres|mysql|redis|mongo)\b/i.test(op || "") ? "DB 오류" : "예외";
  return t;
}

const STATE_TABS = [
  { id: "active", label: "활성" },
  { id: "resolved", label: "해결됨" },
  { id: "ignored", label: "무시됨" },
  { id: "all", label: "전체" },
];
// Badge shown only for states that need calling out in a list (regressed loudest).
const STATE_BADGE: Record<string, { label: string; tone: string }> = {
  regressed: { label: "재발", tone: "err" },
  resolved: { label: "해결됨", tone: "ok" },
  ignored: { label: "무시됨", tone: "muted" },
};

// Per-row triage buttons: resolve / ignore active issues, reopen closed ones.
function IssueActions({ g }: { g: ErrorGroup }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["error-groups"] });
  const m = useMutation({ mutationFn: (state: "active" | "resolved" | "ignored") => setErrorStatus(g.fingerprint, state), onSuccess: invalidate });
  const closed = g.state === "resolved" || g.state === "ignored";
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const busy = (s: string) => m.isPending && m.variables === s; // per-action pending label
  return (
    <div className="err-actions" onClick={stop}>
      {closed ? (
        <button className="btn btn-sm" disabled={m.isPending} onClick={() => m.mutate("active")}>{busy("active") ? "되돌리는 중…" : "되돌리기"}</button>
      ) : (
        <>
          <button className="btn btn-sm" disabled={m.isPending} onClick={() => m.mutate("resolved")} title="해결로 표시">{busy("resolved") ? "해결 중…" : "해결"}</button>
          <button className="btn btn-sm" disabled={m.isPending} onClick={() => m.mutate("ignored")} title="무시 — 활성 목록에서 숨김">{busy("ignored") ? "무시 중…" : "무시"}</button>
        </>
      )}
    </div>
  );
}

function DetailModal({ group, win, onClose, onTrace }: {
  group: ErrorGroup;
  win: { fromISO: string; toISO: string };
  onClose: () => void;
  onTrace: (traceId: string) => void;
}) {
  const { theme } = useTheme();
  const c = chartColors(theme);
  const stepMin = stepFor(win.fromISO, win.toISO);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["error-detail", group.fingerprint, win.fromISO, win.toISO],
    queryFn: () => fetchErrorDetail(group, win.fromISO, win.toISO, stepMin),
  });
  const trend = data?.trend ?? [];
  const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  // Zero-fill a continuous bucket axis (the backend only returns non-empty
  // buckets) so a 2-occurrence issue reads as two small bars on a real timeline,
  // not a fake 50%-wide spike. Bucket boundaries match ClickHouse toStartOfInterval.
  const stepMs = stepMin * 60_000;
  const floorB = (ms: number) => Math.floor(ms / stepMs) * stepMs;
  const startB = floorB(new Date(win.fromISO).getTime());
  const endB = floorB(new Date(win.toISO).getTime());
  const axis: number[] = [];
  for (let b = startB; b <= endB && axis.length < 500; b += stepMs) axis.push(b);
  const countAt = new Map(trend.map((p) => [floorB(new Date(p.minute).getTime()), p.count]));
  const option = {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
    grid: { left: 40, right: 14, top: 12, bottom: 24 },
    xAxis: { type: "category", data: axis.map((b) => hm(new Date(b).toISOString())), axisLabel: { color: c.axis, hideOverlap: true }, axisLine: { lineStyle: { color: c.split } } },
    yAxis: { type: "value", axisLabel: { color: c.axis }, splitLine: { lineStyle: { color: c.split } }, minInterval: 1 },
    series: [{ type: "bar", data: axis.map((b) => countAt.get(b) ?? 0), color: "#f87171", barMaxWidth: 16, itemStyle: { borderRadius: [2, 2, 0, 0] } }],
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" role="dialog" aria-modal="true" aria-label="에러 상세" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <span className="modal-svc">{group.service}</span>
            <span className="modal-txn">{group.operation} · {group.errorType}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기"><IconX /></button>
        </div>
        <div className="modal-body">
          {isError ? <ErrorState error={new Error("에러 상세를 불러오지 못했어요")} onRetry={() => refetch()} /> : <>
          {group.message && <p className="err-detail-msg">{group.message}</p>}
          <div className="err-detail-stats">
            <span><b>{(data?.total ?? group.count).toLocaleString()}</b>회 발생</span>
            <span>처음 <b>{ago(group.firstSeen)}</b></span>
            <span>마지막 <b>{ago(group.lastSeen)}</b></span>
          </div>
          <div className="section-label">발생 추이</div>
          {isLoading ? <Skeleton rows={4} /> : trend.length === 0 ? (
            <p className="err-empty-inline">이 구간에 발생 기록이 없어요.</p>
          ) : <div style={{ height: 160 }}><ReactECharts option={option} style={{ height: "100%" }} notMerge /></div>}
          <div className="section-label">최근 발생 <span className="hint-inline">클릭하면 트레이스</span></div>
          {isLoading ? <Skeleton rows={5} /> : (
            <table className="tbl">
              <thead><tr><th>시각</th><th className="r">상태</th><th>메시지</th><th>트레이스</th></tr></thead>
              <tbody>
                {(data?.samples ?? []).map((s, i) => (
                  <tr key={i} tabIndex={0} style={{ cursor: "pointer" }} onClick={() => onTrace(s.traceId)} onKeyDown={(e) => { if (e.key === "Enter") onTrace(s.traceId); }}>
                    <td>{s.time.slice(11, 19)}</td>
                    <td className="r"><span className={`chip ${s.status >= 500 || s.status === 0 ? "err" : s.status >= 400 ? "warn" : ""}`}><span className="dot" />{s.status || "ERR"}</span></td>
                    <td className="db-stmt" title={s.message}>{s.message || <span className="tx-dim">—</span>}</td>
                    <td className="mono err-trace-cell">{s.traceId.slice(0, 14)}… <span aria-hidden>→</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </>}
        </div>
      </div>
    </div>
  );
}

export function Errors() {
  const { openTrace } = useNav();
  const [sel, setSel] = useTimeSel();
  const minute = Math.floor(Date.now() / 60000);
  const win = resolveSel(sel, minute * 60000);
  const [active, setActive] = useState<ErrorGroup | null>(null);
  const [stateFilter, setStateFilterRaw] = useState(() => {
    const s = getParam("state");
    return s && STATE_TABS.some((t) => t.id === s) ? s : "active";
  });
  const setStateFilter = (s: string) => { setStateFilterRaw(s); replaceParams({ state: s === "active" ? null : s }); };
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["error-groups", stateFilter, win.fromISO, win.toISO],
    queryFn: () => fetchErrorGroups(win.fromISO, win.toISO, stateFilter),
    refetchInterval: win.live ? 10000 : false,
    placeholderData: keepPreviousData,
  });
  const groups = data ?? [];
  const total = groups.reduce((a, g) => a + g.count, 0);
  const regressed = groups.filter((g) => g.state === "regressed").length;
  const openById = (traceId: string) =>
    openTrace({ traceId, serviceName: "", transactionName: "", statusCode: "", startTime: "", durationMs: 0 } as Transaction);
  const emptyBody = stateFilter === "active"
    ? "활성 이슈가 없어요. 에러가 발생하거나 해결한 이슈가 재발하면 여기에 떠요."
    : `이 필터(${STATE_TABS.find((t) => t.id === stateFilter)?.label})에 해당하는 이슈가 없어요.`;

  return (
    <div className="content-scroll">
      <div className="err-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">에러 추적 <span className="hint-inline" role="status" aria-live="polite">{groups.length}개 이슈 · {total.toLocaleString()}건{regressed > 0 && <> · <b className="err-regress-count">재발 {regressed}</b></>}</span></span>
          <div className="bar" style={{ marginLeft: "auto", gap: "var(--sp-3)" }}>
            <div className="segmented" role="tablist" aria-label="상태 필터">
              {STATE_TABS.map((t) => <button key={t.id} role="tab" aria-selected={stateFilter === t.id} className="seg" onClick={() => setStateFilter(t.id)}>{t.label}</button>)}
            </div>
            <TimeRangePicker value={sel} onChange={setSel} />
          </div>
        </div>
        {isError && !data ? (
          <ErrorState error={new Error("에러 목록을 불러오지 못했어요")} onRetry={() => refetch()} />
        ) : isLoading && !data ? (
          <Skeleton rows={10} />
        ) : groups.length === 0 ? (
          <EmptyState title={stateFilter === "active" ? "활성 에러가 없어요 🎉" : "이슈가 없어요"} body={emptyBody} hint={selLabel(sel)} />
        ) : (
          <>
            <StreamStatus sel={sel} everyLabel="10초마다 갱신" />
            <table className="tbl err-tbl">
              <thead>
                <tr><th>이슈</th><th>유형</th><th>메시지</th><th className="r">발생</th><th className="r">마지막</th><th></th></tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const badge = STATE_BADGE[g.state];
                  return (
                    <tr key={g.fingerprint} tabIndex={0} className={g.state === "resolved" || g.state === "ignored" ? "err-row-closed" : ""} style={{ cursor: "pointer" }} onClick={() => setActive(g)} onKeyDown={(e) => { if (e.key === "Enter") setActive(g); }}>
                      <td className="err-issue">
                        <span className="err-svc">{g.service}</span>
                        <span className="err-op">{g.operation || "—"}{badge && <span className={`chip ${badge.tone} err-state-badge`}>{badge.label}</span>}</span>
                      </td>
                      <td><span className={`chip ${typeTone(g.errorType)}`} title={g.errorType}><span className="dot" />{humanType(g.errorType, g.operation)}</span></td>
                      <td className="db-stmt" title={g.message}>{g.message || <span className="tx-dim">—</span>}</td>
                      <td className="r err-count">{g.count.toLocaleString()}</td>
                      <td className="r err-last">{ago(g.lastSeen)}</td>
                      <td className="r"><IssueActions g={g} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
      {active && <DetailModal group={active} win={win} onClose={() => setActive(null)} onTrace={(id) => { setActive(null); openById(id); }} />}
    </div>
  );
}
