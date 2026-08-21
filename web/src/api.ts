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
  httpUrl?: string;
  dbSystem?: string;
  dbStatement?: string;
};

export type TxnFilter = { service?: string; errorsOnly?: boolean; minMs?: number; q?: string; from?: string; to?: string; sort?: "duration"; limit?: number };

export async function fetchTransactions(f: TxnFilter = {}): Promise<Transaction[]> {
  const p = new URLSearchParams({ limit: String(f.limit ?? 100) });
  if (f.service) p.set("service", f.service);
  if (f.errorsOnly) p.set("errors", "1");
  if (f.minMs) p.set("minMs", String(f.minMs));
  if (f.q) p.set("q", f.q);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.sort) p.set("sort", f.sort);
  const r = await fetch(`${BASE}/api/v1/transactions?${p}`);
  if (!r.ok) throw new Error(`transactions ${r.status}`);
  return r.json();
}
// Slowest example traces from a time window — for metric→trace exemplar drill-down.
export function fetchExemplars(service: string, fromISO: string, toISO: string): Promise<Transaction[]> {
  return fetchTransactions({ service, from: fromISO, to: toISO, sort: "duration", limit: 8 });
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
// Every service's RED series in ONE request. The server auto-routes to the
// right tier (minute vs hourly rollup) by window length and reports the
// resolution it served, so the UI can label the downsampling honestly.
export type REDResponse = { resolution: string; from: string; to: string; series: Record<string, REDPoint[]> };
export async function fetchAllRED(fromISO: string, toISO: string): Promise<REDResponse> {
  const r = await fetch(`${BASE}/api/v1/red?from=${fromISO}&to=${toISO}`);
  if (!r.ok) throw new Error(`red ${r.status}`);
  return r.json();
}
// Retention horizons (days) per fidelity tier — drives the picker's availability
// warnings. Cached hard; these change only on a schema/config update.
export type Retention = { traceDays: number; minuteDays: number; hourDays: number };
export async function fetchRetention(): Promise<Retention> {
  const r = await fetch(`${BASE}/api/v1/meta/retention`);
  if (!r.ok) throw new Error(`retention ${r.status}`);
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
export type AlertRule = { id?: string; name: string; service: string; metric: "error_rate" | "p95_ms"; threshold: number; windowMin: number; enabled: boolean; channels?: string[] };
export type Alert = { firedAt: string; ruleId: string; ruleName: string; service: string; metric: string; value: number; threshold: number; state: string };
export async function fetchAlertRules(): Promise<AlertRule[]> {
  const r = await fetch(`${BASE}/api/v1/alert-rules`);
  if (!r.ok) throw new Error(`alert-rules ${r.status}`);
  return r.json();
}
export async function createAlertRule(rule: AlertRule): Promise<AlertRule> {
  const r = await fetch(`${BASE}/api/v1/alert-rules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rule) });
  if (!r.ok) throw new Error(await r.text() || `create ${r.status}`);
  return r.json();
}
// Upsert (create or update) — the POST handler keys on id, so passing an
// existing id updates that rule (used for the enable/disable toggle).
export async function upsertAlertRule(rule: AlertRule): Promise<AlertRule> {
  const r = await fetch(`${BASE}/api/v1/alert-rules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rule) });
  if (!r.ok) throw new Error(await r.text() || `upsert ${r.status}`);
  return r.json();
}
export async function deleteAlertRule(id: string): Promise<void> {
  const r = await fetch(`${BASE}/api/v1/alert-rules/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`delete ${r.status}`);
}
export async function fetchAlerts(): Promise<Alert[]> {
  const r = await fetch(`${BASE}/api/v1/alerts?limit=100`);
  if (!r.ok) throw new Error(`alerts ${r.status}`);
  return r.json();
}

// ── Notification channels + delivery log ─────────────────────
export type Channel = { id?: string; name: string; type: "slack" | "webhook" | "pagerduty"; target: string; enabled: boolean };
export async function fetchChannels(): Promise<Channel[]> {
  const r = await fetch(`${BASE}/api/v1/alert-channels`);
  if (!r.ok) throw new Error(`channels ${r.status}`);
  return r.json();
}
export async function createChannel(c: Channel): Promise<Channel> {
  const r = await fetch(`${BASE}/api/v1/alert-channels`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
  if (!r.ok) throw new Error((await r.text()) || `create ${r.status}`);
  return r.json();
}
export async function deleteChannel(id: string): Promise<void> {
  const r = await fetch(`${BASE}/api/v1/alert-channels/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`delete ${r.status}`);
}
// Returns null on success; a message string when the send failed (502 body).
export async function testChannel(id: string): Promise<string | null> {
  const r = await fetch(`${BASE}/api/v1/alert-channels/${id}/test`, { method: "POST" });
  if (r.ok) return null;
  return (await r.text()) || `전송 실패 (${r.status})`;
}
export type Notification = { ts: string; ruleName: string; channelName: string; type: string; state: string; ok: boolean; error: string };
export async function fetchNotifications(): Promise<Notification[]> {
  const r = await fetch(`${BASE}/api/v1/notifications?limit=100`);
  if (!r.ok) throw new Error(`notifications ${r.status}`);
  return r.json();
}

export type AppOverview = { sessions: number; crashSessions: number; crashFreeRate: number; coldStartP75: number; warmStartP75: number; networkErrRate: number };
export type AppVersion = { version: string; platform: string; sessions: number; crashFreeRate: number };
export type AppGroup = { key: string; sub: string; count: number; avgMs: number };
export async function fetchAppOverview(): Promise<AppOverview> {
  const r = await fetch(`${BASE}/api/v1/app/overview`);
  if (!r.ok) throw new Error(`app overview ${r.status}`);
  return r.json();
}
export async function fetchAppVersions(): Promise<AppVersion[]> {
  const r = await fetch(`${BASE}/api/v1/app/versions`);
  if (!r.ok) throw new Error(`app versions ${r.status}`);
  return r.json();
}
export async function fetchAppGroup(kind: "screens" | "crashes" | "network", limit = 20): Promise<AppGroup[]> {
  const r = await fetch(`${BASE}/api/v1/app/${kind}?limit=${limit}`);
  if (!r.ok) throw new Error(`app ${kind} ${r.status}`);
  return r.json();
}
export type CrashDetail = { message: string; stack: string; sessions: number; count: number; versions: string[]; devices: string[]; oses: string[]; lastSeen: string };
export async function fetchCrashDetail(message: string): Promise<CrashDetail> {
  const r = await fetch(`${BASE}/api/v1/app/crash?message=${encodeURIComponent(message)}`);
  if (!r.ok) throw new Error(`crash detail ${r.status}`);
  return r.json();
}

export type RumOverview = { sessions: number; pageviews: number; errors: number; lcpP75: number; inpP75: number; clsP75: number };
export type RumCount = { key: string; sub: string; count: number; avgMs: number };
export async function fetchRumOverview(): Promise<RumOverview> {
  const r = await fetch(`${BASE}/api/v1/rum/overview`);
  if (!r.ok) throw new Error(`rum overview ${r.status}`);
  return r.json();
}
export async function fetchRumGroup(kind: "clicks" | "errors" | "resources", limit = 30): Promise<RumCount[]> {
  const r = await fetch(`${BASE}/api/v1/rum/${kind}?limit=${limit}`);
  if (!r.ok) throw new Error(`rum ${kind} ${r.status}`);
  return r.json();
}
export type ReplayMeta = { id: string; time: string; sessionId: string; page: string; message: string };
export async function fetchReplays(limit = 30): Promise<ReplayMeta[]> {
  const r = await fetch(`${BASE}/api/v1/rum/replays?limit=${limit}`);
  if (!r.ok) throw new Error(`replays ${r.status}`);
  return r.json();
}
export async function fetchReplay(id: string): Promise<unknown[]> {
  const r = await fetch(`${BASE}/api/v1/rum/replays/${id}`);
  if (!r.ok) throw new Error(`replay ${r.status}`);
  return r.json();
}

export type HostStat = { hasData: boolean; cpuPct: number; memUsed: number; memTotal: number; memPct: number; ncpu: number; load1: number; containersRunning: number; containersTotal: number; time?: string };
export async function fetchHost(): Promise<HostStat> {
  const r = await fetch(`${BASE}/api/v1/infra/host`);
  if (!r.ok) throw new Error(`host ${r.status}`);
  return r.json();
}

export type Container = { container: string; image: string; status: string; cpuPct: number; memBytes: number; memLimit: number; memPct: number; netRx: number; netTx: number; time: string };
export async function fetchContainers(): Promise<Container[]> {
  const r = await fetch(`${BASE}/api/v1/infra/containers`);
  if (!r.ok) throw new Error(`containers ${r.status}`);
  return r.json();
}
export async function fetchContainerSeries(name: string, metric: string): Promise<MetricPoint[]> {
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const r = await fetch(`${BASE}/api/v1/infra/containers/${encodeURIComponent(name)}/series?metric=${metric}&from=${from}&to=${to}`);
  if (!r.ok) throw new Error(`series ${r.status}`);
  return r.json();
}

export type SLOStatus = { service: string; windowHours: number; totalReq: number; totalErr: number; successRate: number; target: number; budgetConsumed: number; budgetRemaining: number; budgetOverBy: number; p95Ms: number; hasLatency: boolean; availStatus: "healthy" | "at_risk" | "breached"; latencyStatus: "healthy" | "at_risk" | "breached"; status: "healthy" | "at_risk" | "breached" };
export async function fetchSLO(fromISO?: string, toISO?: string): Promise<SLOStatus[]> {
  const p = new URLSearchParams();
  if (fromISO) p.set("from", fromISO);
  if (toISO) p.set("to", toISO);
  const r = await fetch(`${BASE}/api/v1/slo?${p}`);
  if (!r.ok) throw new Error(`slo ${r.status}`);
  return r.json();
}

export type ServiceHealth = { service: string; status: "healthy" | "degraded" | "down" | "idle"; reqPerMin: number; errorRate: number; p95Ms: number; anomalies: number; alerting: boolean };
export type HealthSummary = { healthy: number; degraded: number; down: number; idle: number; activeAlerts: number; anomalies: number; monitorsUp: number; monitorsDown: number; monitorsTotal: number };
export async function fetchHealth(): Promise<{ services: ServiceHealth[]; summary: HealthSummary }> {
  const r = await fetch(`${BASE}/api/v1/health`);
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
}

export type Anomaly = { service: string; metric: string; current: number; baseline: number; stddev: number; z: number; direction: "up" | "down"; severity: "warning" | "critical" };
export async function fetchAnomalies(windowMin = 60): Promise<Anomaly[]> {
  const r = await fetch(`${BASE}/api/v1/anomalies?windowMin=${windowMin}`);
  if (!r.ok) throw new Error(`anomalies ${r.status}`);
  return r.json();
}

export type Monitor = { monitor: string; url: string; up: boolean; status: number; latencyMs: number; uptime: number; avgLatencyMs: number; checks: number; lastErr: string; lastAt: string };
export async function fetchMonitors(): Promise<Monitor[]> {
  const r = await fetch(`${BASE}/api/v1/synthetics`);
  if (!r.ok) throw new Error(`synthetics ${r.status}`);
  return r.json();
}
export type UptimeBucket = { time: string; up: boolean; latencyMs: number };
export async function fetchMonitorTimeline(monitor: string): Promise<UptimeBucket[]> {
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const r = await fetch(`${BASE}/api/v1/synthetics/${encodeURIComponent(monitor)}/timeline?bucketSec=60&from=${from}&to=${to}`);
  if (!r.ok) throw new Error(`timeline ${r.status}`);
  return r.json();
}

export type ProfileMeta = { id: string; time: string; target: string; type: string; unit: string; samples: number };
export type FlameNode = { name: string; value: number; children?: FlameNode[] };
export type FuncStat = { name: string; flat: number; cum: number };
export type ProfileDetail = { unit: string; type: string; tree: FlameNode; top: FuncStat[] };
export async function fetchProfiles(limit = 40): Promise<ProfileMeta[]> {
  const r = await fetch(`${BASE}/api/v1/profiles?limit=${limit}`);
  if (!r.ok) throw new Error(`profiles ${r.status}`);
  return r.json();
}
export async function fetchProfile(id: string): Promise<ProfileDetail> {
  const r = await fetch(`${BASE}/api/v1/profiles/${id}`);
  if (!r.ok) throw new Error(`profile ${r.status}`);
  return r.json();
}

export type Panel = { id: string; title: string; type: "red" | "apdex" | "container"; target: string };
export type DashboardSpec = { panels: Panel[] };
export type Dashboard = { id: string; name: string; spec: DashboardSpec };
export async function fetchDashboards(): Promise<Dashboard[]> {
  const r = await fetch(`${BASE}/api/v1/dashboards`);
  if (!r.ok) throw new Error(`dashboards ${r.status}`);
  return r.json();
}
export async function saveDashboard(d: { id?: string; name: string; spec: DashboardSpec }): Promise<Dashboard> {
  const r = await fetch(`${BASE}/api/v1/dashboards`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) });
  if (!r.ok) throw new Error(await r.text() || `save ${r.status}`);
  return r.json();
}
export async function deleteDashboard(id: string): Promise<void> {
  const r = await fetch(`${BASE}/api/v1/dashboards/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`delete ${r.status}`);
}

export type Deploy = { time: string; service: string; version: string; description: string };
export async function fetchDeploys(service = "", limit = 50): Promise<Deploy[]> {
  const p = new URLSearchParams({ limit: String(limit) });
  if (service) p.set("service", service);
  const r = await fetch(`${BASE}/api/v1/deploys?${p}`);
  if (!r.ok) throw new Error(`deploys ${r.status}`);
  return r.json();
}
export async function recordDeploy(d: { service: string; version: string; description?: string }): Promise<void> {
  const r = await fetch(`${BASE}/api/v1/deploys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) });
  if (!r.ok) throw new Error(await r.text() || `deploy ${r.status}`);
}

export type QueryStat = { service: string; statement: string; dbSystem: string; calls: number; avgMs: number; p95Ms: number; maxMs: number; totalMs: number };
export async function fetchDBQueries(orderBy = "total", limit = 50, service = "", fromISO?: string, toISO?: string): Promise<QueryStat[]> {
  const p = new URLSearchParams({ orderBy, limit: String(limit) });
  if (service) p.set("service", service);
  if (fromISO) p.set("from", fromISO);
  if (toISO) p.set("to", toISO);
  const r = await fetch(`${BASE}/api/v1/db/queries?${p}`);
  if (!r.ok) throw new Error(`db queries ${r.status}`);
  return r.json();
}
export type NPlusOne = { service: string; statement: string; traces: number; avgRepeats: number; maxRepeats: number; totalMs: number };
export async function fetchNPlusOne(minRepeats = 5, limit = 50, fromISO?: string, toISO?: string): Promise<NPlusOne[]> {
  const p = new URLSearchParams({ minRepeats: String(minRepeats), limit: String(limit) });
  if (fromISO) p.set("from", fromISO);
  if (toISO) p.set("to", toISO);
  const r = await fetch(`${BASE}/api/v1/db/nplusone?${p}`);
  if (!r.ok) throw new Error(`nplusone ${r.status}`);
  return r.json();
}

export type LogPattern = { pattern: string; sample: string; count: number; errors: number; services: string[]; lastSeen: string };
export async function fetchLogPatterns(severity = "", limit = 40, fromISO?: string, toISO?: string): Promise<LogPattern[]> {
  const p = new URLSearchParams({ limit: String(limit) });
  if (severity) p.set("severity", severity);
  if (fromISO) p.set("from", fromISO);
  if (toISO) p.set("to", toISO);
  const r = await fetch(`${BASE}/api/v1/logs/patterns?${p}`);
  if (!r.ok) throw new Error(`log patterns ${r.status}`);
  return r.json();
}

export type LogLine = { time: string; service: string; severity: string; body: string; traceId: string; spanId: string };
export async function fetchTraceLogs(traceId: string): Promise<LogLine[]> {
  const r = await fetch(`${BASE}/api/v1/traces/${traceId}/logs`);
  if (!r.ok) throw new Error(`trace logs ${r.status}`);
  return r.json();
}
export type LogQuery = { service?: string; severity?: string; q?: string; limit?: number; from?: string; to?: string };
export async function fetchLogs(f: LogQuery = {}): Promise<LogLine[]> {
  const p = new URLSearchParams({ limit: String(f.limit ?? 200) });
  if (f.service) p.set("service", f.service);
  if (f.severity) p.set("severity", f.severity);
  if (f.q) p.set("q", f.q);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  const r = await fetch(`${BASE}/api/v1/logs?${p}`);
  if (!r.ok) throw new Error(`logs ${r.status}`);
  return r.json();
}

// ── Error tracking (issues inbox) ────────────────────────────
export type ErrorGroup = {
  fingerprint: string; service: string; operation: string; errorType: string;
  message: string; count: number; firstSeen: string; lastSeen: string; status: number; sampleTrace: string;
};
export async function fetchErrorGroups(fromISO: string, toISO: string, limit = 100): Promise<ErrorGroup[]> {
  const r = await fetch(`${BASE}/api/v1/errors?from=${fromISO}&to=${toISO}&limit=${limit}`);
  if (!r.ok) throw new Error(`errors ${r.status}`);
  return r.json();
}
export type ErrorSample = { traceId: string; time: string; message: string; status: number };
export type ErrorTrend = { minute: string; count: number };
export type ErrorDetail = { total: number; trend: ErrorTrend[]; samples: ErrorSample[] };
export async function fetchErrorDetail(g: { service: string; operation: string; errorType: string }, fromISO: string, toISO: string, step = 1): Promise<ErrorDetail> {
  const p = new URLSearchParams({ service: g.service, op: g.operation, etype: g.errorType, from: fromISO, to: toISO, step: String(step) });
  const r = await fetch(`${BASE}/api/v1/errors/detail?${p}`);
  if (!r.ok) throw new Error(`error detail ${r.status}`);
  return r.json();
}

// ── Trace/span query (ad-hoc search) ─────────────────────────
export type SpanRow = {
  traceId: string; spanId: string; service: string; name: string; status: string;
  durationMs: number; startTime: string; httpStatus: number; httpRoute: string;
};
// A 400 means the DSL itself is wrong (show inline). Any other failure is
// operational (auth/network) — not the user's query — so it's a distinct type.
export class QuerySyntaxError extends Error {}
export type FacetRow = { key: string; values: number[] };
export type SpanFacets = { kind: "facets"; fields: string[]; aggLabels: string[]; rows: FacetRow[] };
export type SpanQueryResult = { kind: "spans"; spans: SpanRow[] } | SpanFacets;
export async function fetchSpanQuery(q: string, fromISO: string, toISO: string, limit = 200): Promise<SpanQueryResult> {
  const p = new URLSearchParams({ q, from: fromISO, to: toISO, limit: String(limit) });
  const r = await fetch(`${BASE}/api/v1/spans/query?${p}`);
  if (r.status === 400) throw new QuerySyntaxError((await r.text()).trim() || "쿼리 형식을 확인해주세요");
  if (!r.ok) throw new Error("결과를 불러오지 못했어요");
  return r.json();
}

export type ApdexResult = { tMs: number; score: number; samples: number; hasData: boolean; p50Ms: number; p95Ms: number; p99Ms: number; hasPercentiles: boolean };
export async function fetchApdex(service: string, windowMin = 10): Promise<ApdexResult> {
  const r = await fetch(`${BASE}/api/v1/services/${encodeURIComponent(service)}/apdex?windowMin=${windowMin}`);
  if (!r.ok) throw new Error(`apdex ${r.status}`);
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
// Recent root transactions for backfilling live widgets on mount.
export async function fetchRecentTxns(sinceMin = 10): Promise<LiveTxn[]> {
  const r = await fetch(`${BASE}/api/v1/live/recent?sinceMin=${sinceMin}`);
  if (!r.ok) throw new Error(`recent ${r.status}`);
  return r.json();
}

export function liveTxnStream(onTxn: (t: LiveTxn) => void): () => void {
  // EventSource can't set an Authorization header, so pass the token as a query
  // param (the auth middleware accepts it for SSE).
  const tok = (() => { try { return JSON.parse(localStorage.getItem("apm.auth") || "{}").token || ""; } catch { return ""; } })();
  const url = `${BASE}/api/v1/live/transactions${tok ? `?token=${encodeURIComponent(tok)}` : ""}`;
  const es = new EventSource(url);
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
