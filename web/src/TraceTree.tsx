import { useQuery } from "@tanstack/react-query";
import { fetchSpans } from "./api";
import type { Span } from "./api";
import { Skeleton } from "./states";

type Node = Span & { children: Node[] };

function buildTree(spans: Span[]): Node[] {
  const byId = new Map<string, Node>();
  spans.forEach((s) => byId.set(s.spanId, { ...s, children: [] }));
  const roots: Node[] = [];
  byId.forEach((n) => {
    const parent = n.parentSpanId && byId.get(n.parentSpanId);
    if (parent) parent.children.push(n);
    else roots.push(n);
  });
  return roots;
}

function Row({ n, depth, max }: { n: Node; depth: number; max: number }) {
  const width = max > 0 ? Math.max(2, (n.durationMs / max) * 100) : 2;
  const errored = n.statusCode === "ERROR";
  return (
    <>
      <div className="tw-row">
        <div className="tw-label" style={{ paddingLeft: depth * 14 }} title={`${n.serviceName} · ${n.spanName}`}>
          <span className="k">{n.serviceName}</span> · {n.spanName}
        </div>
        <div className="tw-track">
          <div className={`tw-bar ${errored ? "err" : "ok"}`} style={{ width: `${width}%` }} />
        </div>
        <div className="tw-dur">{n.durationMs.toFixed(1)} ms</div>
      </div>
      {n.children.map((c) => <Row key={c.spanId} n={c} depth={depth + 1} max={max} />)}
    </>
  );
}

export function TraceTree({ traceId }: { traceId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["spans", traceId], queryFn: () => fetchSpans(traceId) });
  if (isLoading) return <Skeleton rows={5} />;
  const spans = data ?? [];
  const max = spans.reduce((m, s) => Math.max(m, s.durationMs), 0);
  return <div>{buildTree(spans).map((r) => <Row key={r.spanId} n={r} depth={0} max={max} />)}</div>;
}
