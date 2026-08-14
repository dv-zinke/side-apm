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

function tierOf(ms: number, errored: boolean) {
  if (errored || ms >= 1500) return "err";
  if (ms >= 600) return "slow";
  return "ok";
}

const KIND_ABBR: Record<string, string> = { SERVER: "SVR", CLIENT: "CLI", INTERNAL: "INT", PRODUCER: "PUB", CONSUMER: "SUB" };

function Row({ n, depth, t0, total }: { n: Node; depth: number; t0: number; total: number }) {
  const errored = n.statusCode === "ERROR";
  const tier = tierOf(n.durationMs, errored);
  const start = new Date(n.startTime).getTime() - t0;
  const left = total > 0 ? Math.max(0, (start / total) * 100) : 0;
  const width = total > 0 ? Math.max(0.6, (n.durationMs / total) * 100) : 2;
  return (
    <>
      <div className="tw-row">
        <div className="tw-label" style={{ paddingLeft: depth * 16 }} title={`${n.serviceName} · ${n.spanName}`}>
          {depth > 0 && <span className="tw-guide" style={{ width: depth * 16 }} aria-hidden />}
          <span className={`tw-kind k-${n.spanKind}`}>{KIND_ABBR[n.spanKind] ?? "·"}</span>
          <span className="tw-svc">{n.serviceName}</span>
          <span className="tw-name">{n.spanName}</span>
        </div>
        <div className="tw-track">
          <div className={`tw-bar ${tier}`} style={{ left: `${Math.min(left, 99)}%`, width: `${width}%` }} />
        </div>
        <div className={`tw-dur ${tier}`}>{n.durationMs.toFixed(1)} ms</div>
      </div>
      {n.children.map((c) => <Row key={c.spanId} n={c} depth={depth + 1} t0={t0} total={total} />)}
    </>
  );
}

export function TraceTree({ traceId }: { traceId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["spans", traceId], queryFn: () => fetchSpans(traceId) });
  if (isLoading) return <Skeleton rows={5} />;
  const spans = data ?? [];
  const times = spans.map((s) => new Date(s.startTime).getTime());
  const t0 = times.length ? Math.min(...times) : 0;
  const tEnd = spans.reduce((m, s) => Math.max(m, new Date(s.startTime).getTime() + s.durationMs), t0);
  const total = tEnd - t0;
  return (
    <div className="tw">
      {buildTree(spans).map((r) => <Row key={r.spanId} n={r} depth={0} t0={t0} total={total} />)}
    </div>
  );
}
