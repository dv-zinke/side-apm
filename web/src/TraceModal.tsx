import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RecordSummary } from "./RecordSummary";
import { TraceTree } from "./TraceTree";
import { LogList } from "./LogList";
import { IconX } from "./states";
import { fetchTraceLogs, fetchSpans } from "./api";
import type { Transaction, Span } from "./api";

type Tab = "summary" | "tree" | "sql" | "http" | "logs";

function durClass(ms: number) {
  if (ms >= 1500) return "err";
  if (ms >= 600) return "warn";
  return "";
}

// Trace detail as a tabbed overlay (WhaTap-style): summary / waterfall / SQL /
// HTTP calls / correlated logs — so the dashboard keeps streaming underneath.
export function TraceModal({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("summary");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { data: logs } = useQuery({ queryKey: ["trace-logs", txn.traceId], queryFn: () => fetchTraceLogs(txn.traceId) });
  const { data: spans } = useQuery({ queryKey: ["spans", txn.traceId], queryFn: () => fetchSpans(txn.traceId) });

  const sqlSpans = (spans ?? []).filter((s) => s.dbStatement || s.dbSystem);
  const httpSpans = (spans ?? []).filter((s) => s.spanKind === "CLIENT");

  const TABS: { id: Tab; label: string; n?: number }[] = [
    { id: "summary", label: "레코드 요약" },
    { id: "tree", label: "트리 · 워터폴" },
    { id: "sql", label: "SQL", n: sqlSpans.length },
    { id: "http", label: "HTTP 호출", n: httpSpans.length },
    { id: "logs", label: "로그", n: logs?.length },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" role="dialog" aria-modal="true" aria-label="트레이스 상세" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title">
            <span className="modal-svc">{txn.serviceName}</span>
            <span className="modal-txn">{txn.transactionName || txn.traceId.slice(0, 16)}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기"><IconX /></button>
        </header>

        <div className="modal-tabs" role="tablist" aria-label="트레이스 상세 탭">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
              {t.label}{t.n != null && t.n > 0 && <span className="tab-badge">{t.n}</span>}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === "summary" && <RecordSummary traceId={txn.traceId} />}
          {tab === "tree" && <TraceTree traceId={txn.traceId} />}
          {tab === "sql" && <SpanTable spans={sqlSpans} kind="sql" />}
          {tab === "http" && <SpanTable spans={httpSpans} kind="http" />}
          {tab === "logs" && (logs && logs.length > 0
            ? <LogList logs={logs} />
            : <div className="log-empty">이 트레이스에 연결된 로그가 없어요.</div>)}
        </div>
      </div>
    </div>
  );
}

function SpanTable({ spans, kind }: { spans: Span[]; kind: "sql" | "http" }) {
  if (spans.length === 0) {
    return <div className="log-empty">{kind === "sql" ? "이 트레이스에 SQL 쿼리가 없어요." : "이 트레이스에 외부 HTTP 호출이 없어요."}</div>;
  }
  const sorted = [...spans].sort((a, b) => b.durationMs - a.durationMs);
  return (
    <table className="tbl detail-tbl">
      <thead>
        <tr>
          <th>서비스</th>
          <th>{kind === "sql" ? "쿼리" : "요청"}</th>
          <th className="r">경과</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((s, i) => (
          <tr key={s.spanId + i} style={{ cursor: "default" }}>
            <td className="svc">{s.serviceName}</td>
            <td className="detail-stmt" title={kind === "sql" ? (s.dbStatement || s.spanName) : `${s.httpMethod ?? ""} ${s.httpUrl || s.httpRoute || s.spanName}`}>
              {kind === "sql"
                ? (s.dbStatement || s.spanName)
                : <><span className="http-method">{s.httpMethod || "GET"}</span> {s.httpUrl || s.httpRoute || s.spanName}</>}
            </td>
            <td className={`r ${durClass(s.durationMs)}`}>{s.durationMs.toFixed(1)} ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
