import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import rrwebPlayer from "rrweb-player";
import "rrweb-player/dist/style.css";
import { fetchReplay } from "./api";
import { IconX } from "./states";
import type { ReplayMeta } from "./api";

// Session replay ("error video") — replays the rrweb DOM stream captured when
// the error fired.
export function ReplayModal({ meta, onClose }: { meta: ReplayMeta; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const { data: events, isLoading } = useQuery({ queryKey: ["replay", meta.id], queryFn: () => fetchReplay(meta.id) });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !events || (events as unknown[]).length < 2) return;
    host.innerHTML = "";
    try {
      new rrwebPlayer({ target: host, props: { events: events as never, width: 900, height: 480, autoPlay: true, showController: true } });
    } catch { /* malformed stream */ }
    return () => { if (host) host.innerHTML = ""; };
  }, [events]);

  const enough = events && (events as unknown[]).length >= 2;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-replay" role="dialog" aria-modal="true" aria-label="세션 리플레이" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title">
            <span className="modal-svc">세션 리플레이 · {meta.page}</span>
            <span className="modal-txn" style={{ fontFamily: "var(--sans)", color: "var(--err)" }}>{meta.message}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기"><IconX /></button>
        </header>
        <div className="modal-body replay-body">
          {isLoading ? (
            <div className="log-empty">리플레이를 불러오는 중…</div>
          ) : !enough ? (
            <div className="log-empty">재생할 이벤트가 부족해요 (에러 직전 화면이 기록되지 않았어요).</div>
          ) : (
            <div ref={hostRef} className="replay-host" />
          )}
        </div>
      </div>
    </div>
  );
}
