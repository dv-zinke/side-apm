import { useEffect, useRef } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchTransactions, fetchLogs, fetchDeploys, fetchErrorGroups } from "./api";
import type { Alert, Transaction } from "./api";
import { Skeleton, IconX } from "./states";

// One-screen incident view: given a firing alert, gather the traces / error logs
// / issues / deploys around the fire time for that service — the MTTR workflow
// that stitches already-live signals into a single "investigate" narrative.
// Pure orchestration of existing endpoints; no new backend.

const WINDOW_MIN = 15;
const ms = (n: number) => (n >= 1000 ? (n / 1000).toFixed(2) + "s" : Math.round(n) + "ms");

// Metric value + unit, formatted so raw floats never leak (p95 = 917ms, not 917.2238…).
export function fmtMetric(m: string, n: number): string {
  if (m === "p95_ms") return ms(n);
  if (m === "error_rate" || m === "uptime") return n.toFixed(1) + "%";
  return Math.round(n).toLocaleString() + "건";
}
// "발화 N분 전 / 후" relative to the alert, not to now — what matters for regression is
// how close the deploy sits to the fire, not how long ago either happened.
function relToFire(deployMs: number, fireMs: number): string {
  const min = Math.round((fireMs - deployMs) / 60000);
  if (min <= 0) return `발화 ${Math.abs(min)}분 후`;
  if (min < 60) return `발화 ${min}분 전`;
  const h = Math.floor(min / 60), rm = min % 60;
  return `발화 ${h}시간${rm ? ` ${rm}분` : ""} 전`;
}
// Raw transport codes ("HTTP 0", bare method) mean nothing to a human — normalize.
function niceErrType(t: string): string { return !t || t === "HTTP 0" ? "미분류" : t; }
function niceMsg(msg: string, op: string): string {
  const m = (msg || "").trim();
  if (!m || /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(m)) return op || "메시지 없음";
  return m;
}

function PanelErr({ q, label }: { q: UseQueryResult<unknown>; label: string }) {
  return (
    <p className="inc-err" role="alert">
      {label} 데이터를 불러오지 못했어요. <button className="link-btn" onClick={() => q.refetch()}>다시 시도</button>
    </p>
  );
}

export function IncidentModal({ alert, onClose, onTrace }: { alert: Alert; onClose: () => void; onTrace: (t: Transaction) => void }) {
  const at = new Date(alert.firedAt).getTime();
  const fromISO = new Date(at - WINDOW_MIN * 60000).toISOString();
  const toISO = new Date(at + WINDOW_MIN * 60000).toISOString();
  const svc = alert.service;
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus into the dialog on open, restore focus + trap Tab, Esc closes.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "Tab" && dialogRef.current) {
        const f = dialogRef.current.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [onClose]);

  const traces = useQuery({ queryKey: ["inc-traces", svc, alert.firedAt], queryFn: () => fetchTransactions({ service: svc, sort: "duration", limit: 8, from: fromISO, to: toISO }) });
  const errs = useQuery({ queryKey: ["inc-errs", svc, alert.firedAt], queryFn: () => fetchLogs({ service: svc, severity: "ERROR", limit: 12, from: fromISO, to: toISO }) });
  const issues = useQuery({ queryKey: ["inc-issues", svc, alert.firedAt], queryFn: () => fetchErrorGroups(fromISO, toISO, "all", 100) });
  // A deploy in the ~2h before the fire is the prime regression suspect.
  const deploys = useQuery({ queryKey: ["inc-deploys", svc, alert.firedAt], queryFn: () => fetchDeploys(svc, 20, new Date(at - 2 * 3600000).toISOString(), toISO) });

  const svcIssues = (issues.data ?? []).filter((g) => g.service === svc).slice(0, 6);
  const suspectDeploy = (deploys.data ?? []).filter((d) => new Date(d.time).getTime() <= at).sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())[0];
  const openTrace = (traceId: string, name: string) =>
    onTrace({ traceId, serviceName: svc, transactionName: name, statusCode: "", startTime: "", durationMs: 0 } as Transaction);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`인시던트 조사 — ${alert.ruleName}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <span className="modal-svc">인시던트 · {svc}</span>
            <span className="modal-txn" style={{ fontFamily: "var(--sans)" }}>{alert.ruleName}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기"><IconX /></button>
        </div>
        <div className="modal-body">
          <div className="inc-summary">
            <span className={`chip ${alert.state === "firing" ? "err" : "ok"}`}><span className="dot" />{alert.state === "firing" ? "발화 중" : "해제됨"}</span>
            <span className="inc-metric">{fmtMetric(alert.metric, alert.value)} <span className="tx-dim">/ 임계 {fmtMetric(alert.metric, alert.threshold)}</span></span>
            <span className="inc-time">{new Date(alert.firedAt).toLocaleString()}</span>
          </div>

          {/* Regression suspect */}
          {deploys.isError ? (
            <div className="inc-deploy muted"><PanelErr q={deploys} label="배포 이력" /></div>
          ) : deploys.isLoading ? null : suspectDeploy ? (
            <div className="inc-deploy" role="note">
              <span aria-hidden>🚀</span> {relToFire(new Date(suspectDeploy.time).getTime(), at)} <b>{suspectDeploy.version}</b> 배포 — 회귀 의심
              {suspectDeploy.description && <span className="tx-dim"> · {suspectDeploy.description}</span>}
            </div>
          ) : (
            <div className="inc-deploy muted">발화 직전 배포는 없어요 — 코드 변경이 원인은 아닐 수 있어요.</div>
          )}

          <div className="inc-grid">
            <section className="inc-panel">
              <div className="section-label">느린 트레이스 <span className="hint-inline">±{WINDOW_MIN}분 · 클릭하면 워터폴</span></div>
              {traces.isError ? <PanelErr q={traces} label="트레이스" /> : traces.isLoading ? <Skeleton rows={4} /> : (traces.data ?? []).length === 0 ? <p className="inc-empty">이 구간에 트레이스가 없어요.</p> : (
                <table className="tbl inc-tbl">
                  <thead><tr><th>트랜잭션</th><th className="r">지연</th><th className="r">상태</th></tr></thead>
                  <tbody>
                    {(traces.data ?? []).map((t, i) => (
                      <tr key={i} tabIndex={0} style={{ cursor: "pointer" }} onClick={() => openTrace(t.traceId, t.transactionName)} onKeyDown={(e) => { if (e.key === "Enter") openTrace(t.traceId, t.transactionName); }}>
                        <td className="db-stmt" title={t.transactionName}>{t.transactionName || "—"}</td>
                        <td className={`r ${t.durationMs >= 1000 ? "err" : t.durationMs >= 300 ? "warn" : ""}`}>{ms(t.durationMs)}</td>
                        <td className="r"><span className={`chip ${t.statusCode === "ERROR" ? "err" : ""}`}><span className="dot" />{t.statusCode === "ERROR" ? "ERR" : "OK"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="inc-panel">
              <div className="section-label">에러 이슈 <span className="hint-inline">이 서비스 · ±{WINDOW_MIN}분</span></div>
              {issues.isError ? <PanelErr q={issues} label="에러 이슈" /> : issues.isLoading ? <Skeleton rows={4} /> : svcIssues.length === 0 ? <p className="inc-empty">에러 이슈가 없어요.</p> : (
                <table className="tbl inc-tbl">
                  <thead><tr><th>유형</th><th>메시지</th><th className="r">발생</th></tr></thead>
                  <tbody>
                    {svcIssues.map((g) => (
                      <tr key={g.fingerprint} tabIndex={0} style={{ cursor: "pointer" }} onClick={() => openTrace(g.sampleTrace, g.operation)} onKeyDown={(e) => { if (e.key === "Enter") openTrace(g.sampleTrace, g.operation); }}>
                        <td><span className={`chip ${g.errorType.startsWith("HTTP 4") ? "warn" : "err"}`}><span className="dot" />{niceErrType(g.errorType)}</span></td>
                        <td className="db-stmt" title={niceMsg(g.message, g.operation)}>{niceMsg(g.message, g.operation)}</td>
                        <td className="r">{g.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <section className="inc-panel">
            <div className="section-label">에러 로그 <span className="hint-inline">심각도 ERROR · ±{WINDOW_MIN}분 · 클릭하면 트레이스</span></div>
            {errs.isError ? <PanelErr q={errs} label="에러 로그" /> : errs.isLoading ? <Skeleton rows={3} /> : (errs.data ?? []).length === 0 ? <p className="inc-empty">이 구간에 ERROR 로그가 없어요.</p> : (
              <div className="loglist inc-logs">
                {(errs.data ?? []).map((l, i) => (
                  <div key={i} className={`logrow ${l.traceId ? "clickable" : ""}`} tabIndex={l.traceId ? 0 : undefined} onClick={() => l.traceId && openTrace(l.traceId, l.body)} onKeyDown={(e) => { if (e.key === "Enter" && l.traceId) openTrace(l.traceId, l.body); }}>
                    <span className="log-time">{l.time.slice(11, 19)}</span>
                    <span className="chip err log-sev"><span className="dot" />ERROR</span>
                    <span className="log-body" title={l.body}>{l.body}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
