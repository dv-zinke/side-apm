import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { RecordSummary } from "./RecordSummary";
import { TraceTree } from "./TraceTree";
import { LogList } from "./LogList";
import { IconX } from "./states";
import { fetchTraceLogs } from "./api";
import type { Transaction } from "./api";

// Trace detail as an overlay so drilling in from a live widget never leaves the
// dashboard — the speed band / heatmap keep streaming underneath.
export function TraceModal({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const { data: logs } = useQuery({ queryKey: ["trace-logs", txn.traceId], queryFn: () => fetchTraceLogs(txn.traceId) });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="트레이스 상세" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title">
            <span className="modal-svc">{txn.serviceName}</span>
            <span className="modal-txn">{txn.transactionName || txn.traceId.slice(0, 16)}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기"><IconX /></button>
        </header>
        <div className="modal-body">
          <div className="section-label">레코드 요약</div>
          <RecordSummary traceId={txn.traceId} />
          <div className="section-label">트리 뷰 · 워터폴</div>
          <TraceTree traceId={txn.traceId} />
          <div className="section-label">상관 로그 {logs && logs.length > 0 && <span className="chip muted" style={{ marginLeft: 6 }}><span className="dot" />{logs.length}</span>}</div>
          {logs && logs.length > 0
            ? <LogList logs={logs} />
            : <div className="log-empty">이 트레이스에 연결된 로그가 없어요.</div>}
        </div>
      </div>
    </div>
  );
}
