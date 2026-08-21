import { useState, useEffect } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { fetchSpanQuery, QuerySyntaxError } from "./api";
import type { Transaction, SpanQueryResult, SpanFacets, SpanRow } from "./api";
import { EmptyState, Skeleton } from "./states";
import { useNav } from "./nav";
import { TimeRangePicker, resolveSel, selLabel, useTimeSel } from "./range";
import { getParam, replaceParams } from "./urlState";

// One-tap starter queries — teach the DSL by example (filters + aggregation).
const EXAMPLES = [
  `duration > 1s`,
  `status = error`,
  `status = error | stats count by service`,
  `duration > 100ms | stats count, p95 by route`,
  `service = "shop-web" AND duration > 500ms`,
  `| stats errors, count by service`,
];

const FIELDS = "service · name · route · method · db · kind · status · httpstatus · duration · attr.<키> · res.<키>";
const OPS = `=  !=  >  <  >=  <=  ~(포함)  !~  ·  AND 로 연결`;
const STATS = `… | stats <함수> by <필드>  ·  함수: count · errors · avg · p50 · p95 · p99 · max · min`;

function ms(n: number) { return n >= 1000 ? (n / 1000).toFixed(2) + "s" : n.toFixed(n < 10 ? 1 : 0) + "ms"; }
function durTone(n: number) { return n >= 1000 ? "err" : n >= 300 ? "warn" : ""; }
// Aggregate value formatting: latency columns stay in ms (with separators) so
// p95 values compare precisely across groups; counts are plain integers.
function fmtVal(label: string, v: number) { return label.includes("ms") ? Math.round(v).toLocaleString() + "ms" : Math.round(v).toLocaleString(); }

function FacetView({ res }: { res: SpanFacets }) {
  const maxFirst = Math.max(1, ...res.rows.map((r) => r.values[0] ?? 0));
  return (
    <table className="tbl q-facet-tbl">
      <thead>
        <tr><th>{res.fields.join(" · ")}</th>{res.aggLabels.map((l) => <th key={l} className="r">{l}</th>)}</tr>
      </thead>
      <tbody>
        {res.rows.map((r, i) => (
          <tr key={i}>
            <td className="q-facet-key" title={r.key}>{r.key}</td>
            {r.values.map((v, j) => (
              <td key={j} className="r q-facet-val" data-label={res.aggLabels[j]}>
                {j === 0 && <span className="q-facet-bar" style={{ width: `${Math.max(2, (v / maxFirst) * 100)}%` }} aria-hidden />}
                <span className="q-facet-num">{fmtVal(res.aggLabels[j], v)}</span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Explore() {
  const { openTrace } = useNav();
  const [sel, setSel] = useTimeSel();
  const minute = Math.floor(Date.now() / 60000);
  const win = resolveSel(sel, minute * 60000);
  const [input, setInput] = useState(getParam("q") ?? "");
  const [q, setQ] = useState(getParam("q") ?? "");
  const [help, setHelp] = useState(false);
  const [lastGood, setLastGood] = useState<SpanQueryResult | null>(null);
  const ran = q.trim() !== "";

  const submit = (next?: string) => {
    const query = (next ?? input).trim();
    if (next !== undefined) setInput(next);
    setQ(query);
    replaceParams({ q: query || null });
  };

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["span-query", q, win.fromISO, win.toISO],
    queryFn: () => fetchSpanQuery(q, win.fromISO, win.toISO),
    enabled: ran, // don't auto-dump all spans; invite via chips first
    retry: false, // a 400 is a user syntax error, not a transient failure
    placeholderData: keepPreviousData,
  });
  useEffect(() => { if (data) setLastGood(data); }, [data]);

  const syntaxErr = isError && error instanceof QuerySyntaxError;
  const opErr = isError && !(error instanceof QuerySyntaxError);
  // On a syntax error keep the last good result visible (dimmed) instead of
  // wiping it — like Datadog/NRQL.
  const result = data ?? (syntaxErr ? lastGood : null);
  let facets: SpanFacets | null = null;
  let spans: SpanRow[] = [];
  if (result?.kind === "facets") facets = result;
  else if (result?.kind === "spans") spans = result.spans;
  const hasResult = (facets?.rows.length ?? 0) > 0 || spans.length > 0;
  const openById = (traceId: string) =>
    openTrace({ traceId, serviceName: "", transactionName: "", statusCode: "", startTime: "", durationMs: 0 } as Transaction);

  return (
    <div className="content-scroll">
      <div className="explore-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">탐색 <span className="hint-inline">스팬을 속성으로 검색</span></span>
          <div style={{ marginLeft: "auto" }}><TimeRangePicker value={sel} onChange={setSel} /></div>
        </div>

        <div className="q-bar">
          <input
            className="input q-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder={`service = "shop-web" AND duration > 500ms`}
            aria-label="스팬 쿼리"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button className="btn btn-primary" onClick={() => submit()}>실행</button>
          <button className="btn q-help-btn" aria-expanded={help} onClick={() => setHelp((h) => !h)}>문법</button>
        </div>

        {help && (
          <div className="q-help">
            <div><b>필드</b> <code>{FIELDS}</code></div>
            <div><b>연산자</b> <code>{OPS}</code></div>
            <div><b>집계</b> <code>{STATS}</code></div>
            <div className="q-help-note">값은 따옴표로 감싸고(<code>"shop-web"</code>), 시간은 <code>1s·500ms·2m</code>, 상태는 <code>error·ok</code> 또는 숫자.</div>
          </div>
        )}

        <div className="q-examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="q-chip" onClick={() => submit(ex)}><code>{ex}</code></button>
          ))}
        </div>

        {syntaxErr && (
          <div className="q-error" role="alert">
            <b>쿼리를 이해하지 못했어요</b> — {(error as Error).message}
          </div>
        )}
        {opErr && (
          <div className="q-error" role="alert">
            <b>결과를 불러오지 못했어요</b> — 잠시 후 <button className="q-retry" onClick={() => submit()}>다시 시도</button>해주세요.
          </div>
        )}

        {!ran ? (
          <EmptyState title="스팬을 검색해보세요" body="조건으로 스팬을 좁히거나 `| stats` 로 집계하세요. 예: status = error | stats count by service. 예시 칩을 눌러 시작할 수도 있어요." hint={selLabel(sel)} />
        ) : isLoading ? (
          <Skeleton rows={10} />
        ) : result?.kind === "facets" && facets?.rows.length === 0 && !opErr ? (
          <EmptyState title="해당하는 그룹이 없어요" body="이 조건에 맞는 스팬이 없어 집계할 게 없어요. 필터를 넓히거나 다른 필드로 그룹화해보세요." hint={selLabel(sel)} />
        ) : !hasResult && !opErr ? (
          <EmptyState title="일치하는 스팬이 없어요" body="조건을 넓히거나 기간을 바꿔보세요. 예시 칩을 눌러 시작할 수도 있어요." hint={selLabel(sel)} />
        ) : facets ? (
          <div className={syntaxErr ? "q-results-stale" : ""}>
            <div className="q-result-meta">{facets.rows.length.toLocaleString()}개 그룹{facets.rows.length >= 200 ? "+ (상위만)" : ""} · {facets.fields.join(" · ")} 기준 · {selLabel(sel)}{isFetching ? " · 갱신 중…" : ""}</div>
            <FacetView res={facets} />
          </div>
        ) : spans.length > 0 ? (
          <div className={syntaxErr ? "q-results-stale" : ""}>
            <div className="q-result-meta">{spans.length.toLocaleString()}개 스팬{spans.length >= 200 ? "+" : ""} · {selLabel(sel)}{isFetching ? " · 갱신 중…" : ""}</div>
            <table className="tbl q-tbl">
              <thead>
                <tr><th>시각</th><th>스팬</th><th className="r">상태</th><th className="r">지연</th></tr>
              </thead>
              <tbody>
                {spans.map((s, i) => (
                  <tr key={i} tabIndex={0} style={{ cursor: "pointer" }} onClick={() => openById(s.traceId)} onKeyDown={(e) => { if (e.key === "Enter") openById(s.traceId); }}>
                    <td className="q-time">{s.startTime.slice(11, 19)}</td>
                    <td className="q-span">
                      <span className="q-span-svc">{s.service}</span>
                      <span className="q-span-name" title={s.name}>{s.name}</span>
                    </td>
                    <td className="r"><span className={`chip ${s.status === "ERROR" || s.httpStatus >= 500 ? "err" : s.httpStatus >= 400 ? "warn" : ""}`}><span className="dot" />{s.status === "ERROR" ? "ERR" : s.httpStatus || s.status || "OK"}</span></td>
                    <td className={`r ${durTone(s.durationMs)}`}>{ms(s.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
