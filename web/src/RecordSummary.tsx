import { useQuery } from "@tanstack/react-query";
import { fetchSummary } from "./api";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", fontSize: 12 }}>
      <span style={{ color: "#888" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function RecordSummary({ traceId }: { traceId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["summary", traceId], queryFn: () => fetchSummary(traceId) });
  if (isLoading || !data) return <div>로딩…</div>;
  return (
    <div style={{ maxWidth: 420 }}>
      <Field label="트랜잭션" value={data.transactionName || "-"} />
      <Field label="에이전트 명" value={data.entryService} />
      <Field label="경과 시간" value={`${data.durationMs.toFixed(2)} ms`} />
      <Field label="스팬 수" value={data.spanCount} />
      <Field label="에러 수" value={data.errorCount} />
      <Field label="SQL 시간 / 건수" value={`${data.sqlTimeMs.toFixed(2)} ms / ${data.sqlCount}`} />
      <Field label="HTTP 호출 시간 / 건수" value={`${data.httpCallTimeMs.toFixed(2)} ms / ${data.httpCallCount}`} />
      <Field label="HTTP 상태" value={data.rootHttpStatus || "-"} />
    </div>
  );
}
