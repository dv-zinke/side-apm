import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchDBQueries } from "./api";
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

export function Database() {
  const [orderBy, setOrderBy] = useState("total");
  const { data, isLoading } = useQuery({
    queryKey: ["db-queries", orderBy],
    queryFn: () => fetchDBQueries(orderBy, 50),
    refetchInterval: 10000,
  });

  return (
    <div className="content-scroll">
      <div className="db-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">데이터베이스 · 쿼리 집계</span>
          <div className="segmented" role="tablist" aria-label="정렬 기준" style={{ marginLeft: "auto" }}>
            {ORDERS.map((o) => (
              <button key={o.id} role="tab" aria-selected={orderBy === o.id} className="seg" onClick={() => setOrderBy(o.id)}>{o.label}</button>
            ))}
          </div>
        </div>
        {isLoading ? (
          <Skeleton rows={10} />
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            title="아직 수집된 쿼리가 없어요"
            body="에이전트가 DB 스팬(db.system·db.statement)을 보내면 쿼리별 호출·지연이 집계돼요."
          />
        ) : (
          <table className="tbl db-tbl">
            <thead>
              <tr>
                <th>쿼리</th><th>서비스</th>
                <th className="r">호출</th><th className="r">평균</th><th className="r">p95</th>
                <th className="r">최대</th><th className="r">총 시간</th>
              </tr>
            </thead>
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
      </div>
    </div>
  );
}
