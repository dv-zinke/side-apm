import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchServices, fetchLogs } from "./api";
import type { Transaction } from "./api";
import { LogList } from "./LogList";
import { EmptyState, Skeleton } from "./states";
import { useNav } from "./nav";

export function Logs() {
  const { openTrace } = useNav();
  const [service, setService] = useState("");
  const [severity, setSeverity] = useState("");
  const [q, setQ] = useState("");
  const filter = { service, severity, q };
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices, refetchInterval: 30000 });
  const { data, isLoading } = useQuery({
    queryKey: ["logs", filter],
    queryFn: () => fetchLogs(filter),
    refetchInterval: 5000,
  });

  const openById = (traceId: string) =>
    openTrace({ traceId, serviceName: "", transactionName: "", statusCode: "", startTime: "", durationMs: 0 } as Transaction);

  return (
    <div className="content-scroll">
      <div className="logs-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">로그 <span className="hint-inline">행을 클릭하면 트레이스</span></span>
          {data && <span className="chip muted" style={{ marginLeft: "auto" }}><span className="dot" />{data.length}건</span>}
        </div>
        <div className="filterbar" style={{ position: "static" }}>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="본문 검색" aria-label="로그 검색" />
          <select className="select" value={service} onChange={(e) => setService(e.target.value)} aria-label="서비스">
            <option value="">전체 서비스</option>
            {(services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="select" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="심각도">
            <option value="">전체 레벨</option>
            <option value="ERROR">ERROR</option>
            <option value="WARN">WARN</option>
            <option value="INFO">INFO</option>
            <option value="DEBUG">DEBUG</option>
          </select>
        </div>
        {isLoading ? (
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
