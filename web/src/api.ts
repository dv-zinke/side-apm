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

export async function fetchTransactions(): Promise<Transaction[]> {
  const r = await fetch(`${BASE}/api/v1/transactions?limit=100`);
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
