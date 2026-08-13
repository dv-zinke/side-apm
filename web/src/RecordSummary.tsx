import { useQuery } from "@tanstack/react-query";
import { fetchSummary } from "./api";
import { Skeleton } from "./states";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (<><dt>{label}</dt><dd>{value}</dd></>);
}

export function RecordSummary({ traceId }: { traceId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["summary", traceId], queryFn: () => fetchSummary(traceId) });
  if (isLoading || !data) return <Skeleton rows={4} />;
  const errored = data.errorCount > 0;
  return (
    <dl className="kv">
      <Row label="트랜잭션" value={<span className="mono">{data.transactionName || "—"}</span>} />
      <Row label="에이전트" value={data.entryService} />
      <Row label="경과 시간" value={`${data.durationMs.toFixed(1)} ms`} />
      <Row label="스팬 수" value={data.spanCount} />
      <Row label="에러 수" value={<span style={{ color: errored ? "var(--err)" : undefined }}>{data.errorCount}</span>} />
      <Row label="SQL" value={`${data.sqlTimeMs.toFixed(1)} ms · ${data.sqlCount}건`} />
      <Row label="HTTP 호출" value={`${data.httpCallTimeMs.toFixed(1)} ms · ${data.httpCallCount}건`} />
      <Row label="HTTP 상태" value={data.rootHttpStatus || "—"} />
    </dl>
  );
}
