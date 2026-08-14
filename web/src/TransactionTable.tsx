import { useRef, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchTransactions, fetchServices } from "./api";
import type { Transaction } from "./api";
import { Skeleton, ErrorState, EmptyState } from "./states";

function StatusChip({ code }: { code: string }) {
  const isErr = code === "ERROR";
  const isSet = code && code !== "UNSET";
  const cls = isErr ? "err" : isSet ? "ok" : "muted";
  return <span className={`chip ${cls}`}><span className="dot" />{code || "UNSET"}</span>;
}

function durClass(ms: number, status: string): string {
  if (status === "ERROR" || ms >= 1500) return "dur-vslow";
  if (ms >= 600) return "dur-slow";
  return "";
}

export function TransactionTable({
  selected, onSelect, service, onService,
}: {
  selected: Transaction | null; onSelect: (t: Transaction) => void;
  service: string; onService: (s: string) => void;
}) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [minMs, setMinMs] = useState(0);
  const [q, setQ] = useState("");
  const filter = { service, errorsOnly, minMs, q };

  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices, refetchInterval: 30000 });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["transactions", filter],
    queryFn: () => fetchTransactions(filter),
    refetchInterval: 5000,
  });
  const filtered = service || errorsOnly || minMs > 0 || q;

  // Track which trace keys we've already shown so only fresh arrivals flash in.
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  useEffect(() => {
    if (!data) return;
    for (const t of data) seen.current.add(t.traceId + t.startTime);
    primed.current = true;
  }, [data]);

  return (
    <>
      <div className="pane-head">
        <span className="pane-title">트랜잭션</span>
        {data && <span className="chip muted"><span className="dot" />{data.length}건</span>}
      </div>
      <div className="filterbar">
        <input
          className="input" type="search" value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="예: /checkout"
          aria-label="트랜잭션 검색"
        />
        <select className="select" value={service} onChange={(e) => onService(e.target.value)} aria-label="서비스 필터">
          <option value="">전체 서비스</option>
          {(services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="select" value={minMs} onChange={(e) => setMinMs(Number(e.target.value))} aria-label="최소 소요시간">
          <option value={0}>모든 지연</option>
          <option value={100}>≥ 100ms</option>
          <option value={500}>≥ 500ms</option>
          <option value={1000}>≥ 1s</option>
        </select>
        <button
          className={`filter-toggle${errorsOnly ? " on" : ""}`}
          onClick={() => setErrorsOnly((v) => !v)}
          aria-pressed={errorsOnly}
        >
          <span className="dot" />에러만
        </button>
      </div>
      {isLoading ? (
        <Skeleton rows={10} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (data ?? []).length === 0 ? (
        filtered ? (
          <EmptyState
            title="조건에 맞는 트랜잭션이 없어요"
            body="검색어나 필터를 바꿔보세요. 서비스·소요시간·에러 조건을 조합할 수 있어요."
          />
        ) : (
          <EmptyState
            title="아직 수신된 트랜잭션이 없어요"
            body="에이전트가 트레이스를 보내면 여기에 실시간으로 쌓여요. 데모는 sim 프로파일로 트래픽을 만들어보세요."
            hint="docker compose --profile sim up -d"
          />
        )
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>서비스</th><th>트랜잭션</th><th>상태</th><th className="r">경과</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((t) => {
              const key = t.traceId + t.startTime;
              const isSel = selected?.traceId === t.traceId && selected?.startTime === t.startTime;
              const isNew = primed.current && !seen.current.has(key);
              return (
                <tr
                  key={key}
                  className={isNew ? "live-row" : undefined}
                  aria-selected={isSel}
                  tabIndex={0}
                  onClick={() => onSelect(t)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(t); } }}
                >
                  <td className="svc">{t.serviceName}</td>
                  <td>{t.transactionName}</td>
                  <td><StatusChip code={t.statusCode} /></td>
                  <td className={`r ${durClass(t.durationMs, t.statusCode)}`}>{t.durationMs.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
