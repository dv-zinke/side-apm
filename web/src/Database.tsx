import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchDBQueries, fetchNPlusOne } from "./api";
import { EmptyState, Skeleton } from "./states";

const ORDERS = [
  { id: "total", label: "총 소요시간" },
  { id: "max", label: "가장 느림" },
  { id: "calls", label: "호출 많음" },
];

function ms(n: number) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "s";
  return n.toFixed(n < 10 ? 1 : 0) + "ms";
}
function durClass(n: number) { return n >= 1000 ? "err" : n >= 300 ? "warn" : ""; }

function Queries() {
  const [orderBy, setOrderBy] = useState("total");
  const { data, isLoading } = useQuery({ queryKey: ["db-queries", orderBy], queryFn: () => fetchDBQueries(orderBy, 50), refetchInterval: 10000 });
  return (
    <>
      <div className="pane-head" style={{ position: "static", borderTop: 0, paddingTop: 0 }}>
        <span className="pane-title" style={{ fontSize: "var(--fs-sm)", color: "var(--tx-dim)" }}>정렬</span>
        <div className="segmented" role="tablist" aria-label="정렬 기준" style={{ marginLeft: "auto" }}>
          {ORDERS.map((o) => (
            <button key={o.id} role="tab" aria-selected={orderBy === o.id} className="seg" onClick={() => setOrderBy(o.id)}>{o.label}</button>
          ))}
        </div>
      </div>
      {isLoading ? <Skeleton rows={10} /> : (data ?? []).length === 0 ? (
        <EmptyState title="아직 수집된 쿼리가 없어요" body="에이전트가 DB 스팬(db.system·db.statement)을 보내면 쿼리별 호출·지연이 집계돼요." />
      ) : (
        <table className="tbl db-tbl">
          <thead><tr><th>쿼리</th><th>서비스</th><th className="r">호출</th><th className="r">평균</th><th className="r">p95</th><th className="r">최대</th><th className="r">총 시간</th></tr></thead>
          <tbody>
            {(data ?? []).map((q, i) => (
              <tr key={i} style={{ cursor: "default" }}>
                <td className="db-stmt" title={q.statement}>{q.statement}</td>
                <td className="svc">{q.service}</td>
                <td className="r">{q.calls.toLocaleString()}</td>
                <td className={`r ${durClass(q.avgMs)}`}>{ms(q.avgMs)}</td>
                <td className={`r ${durClass(q.p95Ms)}`}>{ms(q.p95Ms)}</td>
                <td className={`r ${durClass(q.maxMs)}`}>{ms(q.maxMs)}</td>
                <td className="r">{ms(q.totalMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function NPlusOne() {
  const { data, isLoading } = useQuery({ queryKey: ["db-nplusone"], queryFn: () => fetchNPlusOne(5, 50), refetchInterval: 10000 });
  return (
    <>
      <p className="db-hint">한 트레이스 안에서 같은 쿼리가 5회 이상 반복되면 N+1 의심 — 반복 조회를 조인·일괄 조회로 바꾸면 응답이 빨라져요.</p>
      {isLoading ? <Skeleton rows={8} /> : (data ?? []).length === 0 ? (
        <EmptyState title="N+1 의심 쿼리가 없어요" body="한 트레이스에서 동일 쿼리가 반복 실행되면 여기에 나타나요. 지금은 깨끗해요." />
      ) : (
        <table className="tbl db-tbl">
          <thead><tr><th>쿼리</th><th>서비스</th><th className="r">트레이스</th><th className="r">평균 반복</th><th className="r">최대 반복</th><th className="r">누적 시간</th></tr></thead>
          <tbody>
            {(data ?? []).map((q, i) => (
              <tr key={i} style={{ cursor: "default" }}>
                <td className="db-stmt" title={q.statement}>{q.statement}</td>
                <td className="svc">{q.service}</td>
                <td className="r">{q.traces.toLocaleString()}</td>
                <td className="r"><span className="chip warn"><span className="dot" />×{q.avgRepeats.toFixed(1)}</span></td>
                <td className="r err">×{q.maxRepeats}</td>
                <td className={`r ${durClass(q.totalMs)}`}>{ms(q.totalMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

const MODES = [{ id: "queries", label: "쿼리 집계" }, { id: "nplusone", label: "N+1 의심" }];

export function Database() {
  const [mode, setMode] = useState("queries");
  return (
    <div className="content-scroll">
      <div className="db-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">데이터베이스</span>
          <div className="segmented" role="tablist" aria-label="보기" style={{ marginLeft: "auto" }}>
            {MODES.map((m) => (
              <button key={m.id} role="tab" aria-selected={mode === m.id} className="seg" onClick={() => setMode(m.id)}>{m.label}</button>
            ))}
          </div>
        </div>
        {mode === "queries" ? <Queries /> : <NPlusOne />}
      </div>
    </div>
  );
}
