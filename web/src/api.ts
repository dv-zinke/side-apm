const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8080";

export type Transaction = {
  traceId: string;
  serviceName: string;
  transactionName: string;
  statusCode: string;
  startTime: string;
  durationMs: number;
};

export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  serviceName: string;
  spanName: string;
  spanKind: string;
  startTime: string;
  durationMs: number;
  statusCode: string;
  httpMethod?: string;
  httpRoute?: string;
  dbSystem?: string;
  dbStatement?: string;
};

export type TxnFilter = { service?: string; errorsOnly?: boolean; minMs?: number; q?: string; limit?: number };

export async function fetchTransactions(f: TxnFilter = {}): Promise<Transaction[]> {
  const p = new URLSearchParams({ limit: String(f.limit ?? 100) });
  if (f.service) p.set("service", f.service);
  if (f.errorsOnly) p.set("errors", "1");
  if (f.minMs) p.set("minMs", String(f.minMs));
  if (f.q) p.set("q", f.q);
  const r = await fetch(`${BASE}/api/v1/transactions?${p}`);
  if (!r.ok) throw new Error(`transactions ${r.status}`);
  return r.json();
}

export async function fetchSpans(traceId: string): Promise<Span[]> {
  const r = await fetch(`${BASE}/api/v1/traces/${traceId}/spans`);
  if (!r.ok) throw new Error(`spans ${r.status}`);
  return r.json();
}

export type TraceSummary = {
  traceId: string; entryService: string; transactionName: string; rootHttpStatus: number;
  startTime: string; durationMs: number; spanCount: number; errorCount: number;
  sqlCount: number; httpCallCount: number; sqlTimeMs: number; httpCallTimeMs: number;
};
export type REDPoint = {
  minute: string; requestCount: number; errorCount: number;
  p50Ms: number; p95Ms: number; p99Ms: number;
};
export async function fetchSummary(traceId: string): Promise<TraceSummary> {
  const r = await fetch(`${BASE}/api/v1/transactions/${traceId}/summary`);
  if (!r.ok) throw new Error(`summary ${r.status}`);
  return r.json();
}
export async function fetchServices(): Promise<string[]> {
  const r = await fetch(`${BASE}/api/v1/services`);
  if (!r.ok) throw new Error(`services ${r.status}`);
  return r.json();
}
export async function fetchRED(service: string, fromISO: string, toISO: string): Promise<REDPoint[]> {
  const r = await fetch(`${BASE}/api/v1/services/${service}/red?from=${fromISO}&to=${toISO}`);
  if (!r.ok) throw new Error(`red ${r.status}`);
  return r.json();
}

export type ServiceMapData = {
  nodes: { name: string; requestCount: number; errorCount: number }[];
  edges: { from: string; to: string; callCount: number; errorCount: number; avgMs: number }[];
};
export async function fetchServiceMap(): Promise<ServiceMapData> {
  const r = await fetch(`${BASE}/api/v1/servicemap`);
  if (!r.ok) throw new Error(`servicemap ${r.status}`);
  return r.json();
}
export type LogLine = { time: string; service: string; severity: string; body: string; traceId: string; spanId: string };
export async function fetchTraceLogs(traceId: string): Promise<LogLine[]> {
  const r = await fetch(`${BASE}/api/v1/traces/${traceId}/logs`);
  if (!r.ok) throw new Error(`trace logs ${r.status}`);
  return r.json();
}
export type LogQuery = { service?: string; severity?: string; q?: string; limit?: number };
export async function fetchLogs(f: LogQuery = {}): Promise<LogLine[]> {
  const p = new URLSearchParams({ limit: String(f.limit ?? 200) });
  if (f.service) p.set("service", f.service);
  if (f.severity) p.set("severity", f.severity);
  if (f.q) p.set("q", f.q);
  const r = await fetch(`${BASE}/api/v1/logs?${p}`);
  if (!r.ok) throw new Error(`logs ${r.status}`);
  return r.json();
}

export type MetricPoint = { time: string; value: number };
export async function fetchMetricNames(service: string): Promise<string[]> {
  const r = await fetch(`${BASE}/api/v1/services/${encodeURIComponent(service)}/metric-names`);
  if (!r.ok) throw new Error(`metric-names ${r.status}`);
  return r.json();
}
export async function fetchMetric(service: string, name: string, fromISO: string, toISO: string): Promise<MetricPoint[]> {
  const p = new URLSearchParams({ name, from: fromISO, to: toISO });
  const r = await fetch(`${BASE}/api/v1/services/${encodeURIComponent(service)}/metrics?${p}`);
  if (!r.ok) throw new Error(`metrics ${r.status}`);
  return r.json();
}

export type LiveTxn = {
  traceId: string; service: string; transaction: string; statusCode: string;
  startTime: string; durationMs: number; isError: boolean;
};
export function liveTxnStream(onTxn: (t: LiveTxn) => void): () => void {
  const es = new EventSource(`${BASE}/api/v1/live/transactions`);
  es.onmessage = (e) => { try { onTxn(JSON.parse(e.data)); } catch {} };
  return () => es.close();
}

// Adapt a streamed transaction into the shape the trace-detail view consumes.
export function liveToTxn(l: LiveTxn): Transaction {
  return {
    traceId: l.traceId,
    serviceName: l.service,
    transactionName: l.transaction,
    statusCode: l.statusCode,
    startTime: l.startTime,
    durationMs: l.durationMs,
  };
}
