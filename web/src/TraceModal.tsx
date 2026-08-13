import { useEffect } from "react";
import { RecordSummary } from "./RecordSummary";
import { TraceTree } from "./TraceTree";
import { IconX } from "./states";
import type { Transaction } from "./api";

// Trace detail as an overlay so drilling in from a live widget never leaves the
// dashboard — the speed band / heatmap keep streaming underneath.
export function TraceModal({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
        </div>
      </div>
    </div>
  );
}
