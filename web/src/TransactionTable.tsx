import { useQuery } from "@tanstack/react-query";
import { fetchTransactions } from "./api";
import type { Transaction } from "./api";

export function TransactionTable({ onSelect }: { onSelect: (t: Transaction) => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["transactions"],
    queryFn: fetchTransactions,
    refetchInterval: 5000,
  });
  if (isLoading) return <div>로딩…</div>;
  if (error) return <div>에러: {String(error)}</div>;
  return (
    <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th align="left">서비스</th><th align="left">트랜잭션</th>
          <th align="left">상태</th><th align="right">경과(ms)</th>
        </tr>
      </thead>
      <tbody>
        {(data ?? []).map((t) => (
          <tr key={t.traceId + t.startTime} onClick={() => onSelect(t)}
              style={{ cursor: "pointer", borderTop: "1px solid #333" }}>
            <td>{t.serviceName}</td>
            <td>{t.transactionName}</td>
            <td style={{ color: t.statusCode === "ERROR" ? "#f66" : "#6c6" }}>{t.statusCode}</td>
            <td align="right">{t.durationMs.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
