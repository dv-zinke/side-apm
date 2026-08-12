import { useQuery } from "@tanstack/react-query";
import { fetchSpans } from "./api";
import type { Span } from "./api";

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
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
        <div style={{ paddingLeft: depth * 16, minWidth: 260, fontSize: 12 }}>
          {n.serviceName} · {n.spanName}
        </div>
        <div style={{ background: "#4a8", height: 10, width: `${width}%` }} />
        <div style={{ fontSize: 11, color: "#999" }}>{n.durationMs}ms</div>
      </div>
      {n.children.map((c) => <Row key={c.spanId} n={c} depth={depth + 1} max={max} />)}
    </>
  );
}

export function TraceTree({ traceId }: { traceId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["spans", traceId],
    queryFn: () => fetchSpans(traceId),
  });
  if (isLoading) return <div>로딩…</div>;
  const spans = data ?? [];
  const max = spans.reduce((m, s) => Math.max(m, s.durationMs), 0);
  return <div>{buildTree(spans).map((r) => <Row key={r.spanId} n={r} depth={0} max={max} />)}</div>;
}
