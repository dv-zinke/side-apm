import { useQuery } from "@tanstack/react-query";
import { fetchTransactions } from "./api";
import type { Transaction } from "./api";
import { Skeleton, ErrorState, EmptyState } from "./states";

function StatusChip({ code }: { code: string }) {
  const isErr = code === "ERROR";
  const isSet = code && code !== "UNSET";
  const cls = isErr ? "err" : isSet ? "ok" : "muted";
  return <span className={`chip ${cls}`}><span className="dot" />{code || "UNSET"}</span>;
}

export function TransactionTable({
  selected, onSelect,
}: { selected: Transaction | null; onSelect: (t: Transaction) => void }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["transactions"],
    queryFn: fetchTransactions,
    refetchInterval: 5000,
  });

  return (
    <>
      <div className="pane-head">
        <span className="pane-title">트랜잭션</span>
        {data && <span className="chip muted"><span className="dot" />{data.length}건</span>}
      </div>
      {isLoading ? (
        <Skeleton rows={10} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (data ?? []).length === 0 ? (
        <EmptyState
          title="아직 수신된 트랜잭션이 없어요"
          body="에이전트가 트레이스를 보내면 여기에 실시간으로 쌓여요. 데모는 demo/node 서버로 트래픽을 만들어보세요."
          hint="GET localhost:3001/buy-request"
        />
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>서비스</th><th>트랜잭션</th><th>상태</th><th className="r">경과</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((t) => {
              const isSel = selected?.traceId === t.traceId && selected?.startTime === t.startTime;
              return (
                <tr
                  key={t.traceId + t.startTime}
                  aria-selected={isSel}
                  tabIndex={0}
                  onClick={() => onSelect(t)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(t); } }}
                >
                  <td className="svc">{t.serviceName}</td>
                  <td>{t.transactionName}</td>
                  <td><StatusChip code={t.statusCode} /></td>
                  <td className="r">{t.durationMs.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
