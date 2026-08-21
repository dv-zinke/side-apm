import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { fetchServices, fetchLogs, fetchLogPatterns, fetchLogQuery, QuerySyntaxError } from "./api";
import type { Transaction, LogPattern, LogQueryResult, LogLine } from "./api";
import { LogList } from "./LogList";
import { FacetView } from "./Explore";
import { EmptyState, Skeleton } from "./states";
import { useNav } from "./nav";
import { TimeRangePicker, StreamStatus, resolveSel, selLabel, useTimeSel, type TimeSel } from "./range";
import { getParam, replaceParams } from "./urlState";

const MODES = [{ id: "stream", label: "스트림" }, { id: "search", label: "검색" }, { id: "patterns", label: "패턴" }];

type Win = { fromISO: string; toISO: string; live: boolean };

const LOG_EXAMPLES = [
  `severity = error`,
  `body ~ "timeout"`,
  `service = "shop-web" AND severity = error`,
  `severity = error | stats count by service`,
  `| stats count, errors by severity`,
];

// DSL log search: field filters + `| stats` facets over apm.logs.
function LogSearch({ win, sel, onTrace }: { win: Win; sel: TimeSel; onTrace: (id: string) => void }) {
  const [input, setInput] = useState(getParam("logq") ?? "");
  const [q, setQ] = useState(getParam("logq") ?? "");
  const [lastGood, setLastGood] = useState<LogQueryResult | null>(null);
  // Persist the query in the URL (like Explore) so the share link reproduces it.
  const submit = (next?: string) => { const v = (next ?? input).trim(); if (next !== undefined) setInput(next); setQ(v); replaceParams({ logq: v || null }); };
  const { data, isLoading, isFetching, isError, error } = useQuery({
    queryKey: ["log-query", q, win.fromISO, win.toISO],
    queryFn: () => fetchLogQuery(q, win.fromISO, win.toISO),
    enabled: q.trim() !== "",
    retry: false,
    placeholderData: keepPreviousData,
  });
  if (data && data !== lastGood) setLastGood(data);
  const syntaxErr = isError && error instanceof QuerySyntaxError;
  const result = data ?? (syntaxErr ? lastGood : null);
  let rows: LogLine[] = [];
  let facets: { fields: string[]; aggLabels: string[]; rows: { key: string; values: number[] }[] } | null = null;
  if (result?.kind === "rows") rows = result.rows;
  else if (result?.kind === "facets") facets = result;

  return (
    <div style={{ padding: "var(--sp-2) var(--sp-4)" }}>
      <div className="q-bar">
        <input className="input q-input" value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder={`severity = error AND body ~ "timeout"`} aria-label="로그 쿼리" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        <button className="btn btn-primary" onClick={() => submit()} disabled={isFetching}>{isFetching ? "실행 중…" : "실행"}</button>
      </div>
      <div className="q-examples">
        {LOG_EXAMPLES.map((ex) => <button key={ex} className="q-chip" onClick={() => submit(ex)}><code>{ex}</code></button>)}
      </div>
      {syntaxErr && <div className="q-error" role="alert"><b>쿼리를 이해하지 못했어요</b> — {(error as Error).message}</div>}
      {q.trim() === "" ? (
        <EmptyState title="로그를 검색해보세요" body={`필드로 로그를 좁히거나 | stats 로 집계하세요. 예: severity = error | stats count by service`} hint={selLabel(sel)} />
      ) : isLoading && !result ? (
        <Skeleton rows={10} />
      ) : facets ? (
        <div className={syntaxErr ? "q-results-stale" : ""}>
          <div className="q-result-meta">{facets.rows.length.toLocaleString()}개 그룹 · {facets.fields.join(" · ")} 기준 · {selLabel(sel)}{isFetching ? " · 갱신 중…" : ""}</div>
          <FacetView res={facets} />
        </div>
      ) : rows.length > 0 ? (
        <div className={syntaxErr ? "q-results-stale" : ""}>
          <div className="q-result-meta">{rows.length.toLocaleString()}개 로그{rows.length >= 200 ? "+ (최근순 상위)" : ""} · {selLabel(sel)}{isFetching ? " · 갱신 중…" : ""}</div>
          <LogList logs={rows} onTrace={onTrace} />
        </div>
      ) : (
        <EmptyState title="일치하는 로그가 없어요" body="조건을 넓히거나 기간을 바꿔보세요. 예시 칩을 눌러 시작할 수도 있어요." hint={selLabel(sel)} />
      )}
    </div>
  );
}

function PatternsTable({ severity, win, onPick }: { severity: string; win: Win; onPick: (q: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["log-patterns", severity, win.fromISO, win.toISO],
    queryFn: () => fetchLogPatterns(severity, 40, win.fromISO, win.toISO),
    refetchInterval: win.live ? 10000 : false,
  });
  if (isLoading) return <Skeleton rows={10} />;
  if ((data ?? []).length === 0) return <EmptyState title="패턴이 없어요" body="로그가 쌓이면 유사한 메시지를 템플릿으로 묶어 보여줘요." />;
  // A searchable literal from the template: leading text before the first placeholder.
  const literal = (p: string) => p.split("<")[0].trim() || p;
  return (
    <table className="tbl log-pat-tbl">
      <thead><tr><th>패턴</th><th className="r">건수</th><th className="r">에러</th><th>서비스</th><th className="r">마지막</th></tr></thead>
      <tbody>
        {(data ?? []).map((p: LogPattern, i) => (
          <tr key={i} tabIndex={0} onClick={() => onPick(literal(p.pattern))} onKeyDown={(e) => { if (e.key === "Enter") onPick(literal(p.pattern)); }}>
            <td className="log-pat" title={p.sample}>{p.pattern}</td>
            <td className="r">{p.count.toLocaleString()}</td>
            <td className={`r ${p.errors > 0 ? "err" : ""}`}>{p.errors ? p.errors.toLocaleString() : "—"}</td>
            <td className="svc">{p.services.slice(0, 3).join(", ")}{p.services.length > 3 ? " +" + (p.services.length - 3) : ""}</td>
            <td className="r log-pat-time">{p.lastSeen.slice(11, 19)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Logs() {
  const { openTrace } = useNav();
  const [mode, setMode] = useState("stream");
  const [service, setService] = useState("");
  const [severity, setSeverity] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useTimeSel();
  // Bucket "now" to the minute so live windows key stably between refetches.
  const minute = Math.floor(Date.now() / 60000);
  const win = resolveSel(sel, minute * 60000);
  const filter = { service, severity, q, from: win.fromISO, to: win.toISO };
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices, refetchInterval: 30000 });
  const { data, isLoading } = useQuery({
    queryKey: ["logs", service, severity, q, win.fromISO, win.toISO],
    queryFn: () => fetchLogs(filter),
    // Absolute window = historical search → stop the live tail so it stays put.
    refetchInterval: win.live ? 5000 : false,
    enabled: mode === "stream",
  });

  const openById = (traceId: string) =>
    openTrace({ traceId, serviceName: "", transactionName: "", statusCode: "", startTime: "", durationMs: 0 } as Transaction);

  return (
    <div className="content-scroll">
      <div className="logs-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">로그 <span className="hint-inline">{mode === "patterns" ? "유사 메시지를 템플릿으로 묶어요" : mode === "search" ? "필드·본문으로 검색하고 집계" : "행을 클릭하면 트레이스"}</span></span>
          <div className="bar" style={{ marginLeft: "auto", gap: "var(--sp-3)" }}>
            <TimeRangePicker value={sel} onChange={setSel} />
            <div className="segmented" role="tablist" aria-label="보기">
              {MODES.map((m) => (
                <button key={m.id} role="tab" aria-selected={mode === m.id} className="seg" onClick={() => setMode(m.id)}>{m.label}</button>
              ))}
            </div>
          </div>
        </div>
        {mode !== "search" && (
          <div className="filterbar" style={{ position: "static" }}>
            {mode === "stream" && <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="본문 검색" aria-label="로그 검색" />}
            {mode === "stream" && (
              <select className="select" value={service} onChange={(e) => setService(e.target.value)} aria-label="서비스">
                <option value="">전체 서비스</option>
                {(services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            <select className="select" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="심각도">
              <option value="">전체 레벨</option>
              <option value="ERROR">ERROR</option>
              <option value="WARN">WARN</option>
              <option value="INFO">INFO</option>
              <option value="DEBUG">DEBUG</option>
            </select>
          </div>
        )}
        {mode === "search" ? (
          <LogSearch win={win} sel={sel} onTrace={openById} />
        ) : mode === "patterns" ? (
          <div style={{ padding: "var(--sp-2) var(--sp-4)" }}>
            <PatternsTable severity={severity} win={win} onPick={(term) => { setQ(term); setMode("stream"); }} />
          </div>
        ) : isLoading ? (
          <Skeleton rows={12} />
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            title="조건에 맞는 로그가 없어요"
            body="검색어·서비스·레벨·기간을 바꿔보세요. 로그는 트레이스와 자동으로 연결돼요."
            hint={selLabel(sel)}
          />
        ) : (
          <div style={{ padding: "var(--sp-2) var(--sp-4)" }}>
            <StreamStatus sel={sel} everyLabel="5초마다 갱신" />
            <LogList logs={data ?? []} onTrace={openById} />
          </div>
        )}
      </div>
    </div>
  );
}
