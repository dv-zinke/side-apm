import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchServices, fetchLogs, fetchLogPatterns } from "./api";
import type { Transaction, LogPattern } from "./api";
import { LogList } from "./LogList";
import { EmptyState, Skeleton } from "./states";
import { useNav } from "./nav";

const MODES = [{ id: "stream", label: "스트림" }, { id: "patterns", label: "패턴" }];

function PatternsTable({ severity, onPick }: { severity: string; onPick: (q: string) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ["log-patterns", severity], queryFn: () => fetchLogPatterns(severity, 40), refetchInterval: 10000 });
  if (isLoading) return <Skeleton rows={10} />;
  if ((data ?? []).length === 0) return <EmptyState title="패턴이 없어요" body="로그가 쌓이면 유사한 메시지를 템플릿으로 묶어 보여줘요." />;
  // A searchable literal from the template: leading text before the first placeholder.
  const literal = (p: string) => p.split("<")[0].trim() || p;
  return (
    <table className="tbl log-pat-tbl">
      <thead><tr><th>패턴</th><th className="r">건수</th><th className="r">에러</th><th>서비스</th><th className="r">마지막</th></tr></thead>
      <tbody>
        {(data ?? []).map((p: LogPattern, i) => (
          <tr key={i} tabIndex={0} onClick={() => onPick(literal(p.pattern))} onKeyDown={(e) => { if (e.key === "Enter") onPick(literal(p.pattern)); }}>
            <td className="log-pat" title={p.sample}>{p.pattern}</td>
            <td className="r">{p.count.toLocaleString()}</td>
            <td className={`r ${p.errors > 0 ? "err" : ""}`}>{p.errors ? p.errors.toLocaleString() : "—"}</td>
            <td className="svc">{p.services.slice(0, 3).join(", ")}{p.services.length > 3 ? " +" + (p.services.length - 3) : ""}</td>
            <td className="r log-pat-time">{p.lastSeen.slice(11, 19)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Logs() {
  const { openTrace } = useNav();
  const [mode, setMode] = useState("stream");
  const [service, setService] = useState("");
  const [severity, setSeverity] = useState("");
  const [q, setQ] = useState("");
  const filter = { service, severity, q };
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices, refetchInterval: 30000 });
  const { data, isLoading } = useQuery({
    queryKey: ["logs", filter],
    queryFn: () => fetchLogs(filter),
    refetchInterval: 5000,
    enabled: mode === "stream",
  });

  const openById = (traceId: string) =>
    openTrace({ traceId, serviceName: "", transactionName: "", statusCode: "", startTime: "", durationMs: 0 } as Transaction);

  return (
    <div className="content-scroll">
      <div className="logs-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">로그 <span className="hint-inline">{mode === "patterns" ? "유사 메시지를 템플릿으로 묶어요" : "행을 클릭하면 트레이스"}</span></span>
          <div className="segmented" role="tablist" aria-label="보기" style={{ marginLeft: "auto" }}>
            {MODES.map((m) => (
              <button key={m.id} role="tab" aria-selected={mode === m.id} className="seg" onClick={() => setMode(m.id)}>{m.label}</button>
            ))}
          </div>
        </div>
        <div className="filterbar" style={{ position: "static" }}>
          {mode === "stream" && <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="본문 검색" aria-label="로그 검색" />}
          {mode === "stream" && (
            <select className="select" value={service} onChange={(e) => setService(e.target.value)} aria-label="서비스">
              <option value="">전체 서비스</option>
              {(services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <select className="select" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="심각도">
            <option value="">전체 레벨</option>
            <option value="ERROR">ERROR</option>
            <option value="WARN">WARN</option>
            <option value="INFO">INFO</option>
            <option value="DEBUG">DEBUG</option>
          </select>
        </div>
        {mode === "patterns" ? (
          <div style={{ padding: "var(--sp-2) var(--sp-4)" }}>
            <PatternsTable severity={severity} onPick={(term) => { setQ(term); setMode("stream"); }} />
          </div>
        ) : isLoading ? (
          <Skeleton rows={12} />
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            title="조건에 맞는 로그가 없어요"
            body="검색어·서비스·레벨을 바꿔보세요. 로그는 트레이스와 자동으로 연결돼요."
          />
        ) : (
          <div style={{ padding: "var(--sp-2) var(--sp-4)" }}>
            <LogList logs={data ?? []} onTrace={openById} />
          </div>
        )}
      </div>
    </div>
  );
}
