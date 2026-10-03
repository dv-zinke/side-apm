import { useEffect } from "react";
import { IconX } from "./states";
import type { LiveTxn } from "./api";

function chipCls(t: LiveTxn) {
  if (t.isError || t.durationMs >= 1500) return "err";
  if (t.durationMs >= 600) return "warn";
  return "ok";
}

// Transactions captured by a heatmap drag-select — pick one to open its trace.
export function TxnListModal({ txns, label, onClose, onPick }: {
  txns: LiveTxn[]; label: string; onClose: () => void; onPick: (t: LiveTxn) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sorted = [...txns].sort((a, b) => b.durationMs - a.durationMs);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="선택한 트랜잭션" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title">
            <span className="modal-svc">선택 구간</span>
            <span className="modal-txn" style={{ fontFamily: "var(--sans)" }}>{label} · {txns.length}건</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기"><IconX /></button>
        </header>
        <div className="modal-body" style={{ padding: 0 }}>
          <table className="tbl">
            <thead><tr><th>서비스</th><th>트랜잭션</th><th>상태</th><th className="r">경과</th></tr></thead>
            <tbody>
              {sorted.map((t, i) => (
                <tr key={t.traceId + i} tabIndex={0} onClick={() => onPick(t)}
                    onKeyDown={(e) => { if (e.key === "Enter") onPick(t); }}>
                  <td className="svc">{t.service}</td>
                  <td>{t.transaction}</td>
                  <td><span className={`chip ${chipCls(t)}`}><span className="dot" />{t.isError ? "ERROR" : t.statusCode || "OK"}</span></td>
                  <td className="r">{t.durationMs.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
