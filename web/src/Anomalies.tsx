import { useQuery } from "@tanstack/react-query";
import { fetchAnomalies } from "./api";
import type { Anomaly } from "./api";
import { EmptyState, Skeleton } from "./states";

const METRIC_LABEL: Record<string, string> = { p95_ms: "응답시간 p95", error_rate: "에러율", throughput: "처리량" };
function fmt(metric: string, v: number) {
  if (metric === "p95_ms") return v >= 1000 ? (v / 1000).toFixed(1) + "s" : v.toFixed(0) + "ms";
  if (metric === "error_rate") return v.toFixed(1) + "%";
  return v.toFixed(0) + "/분";
}

// A one-line, honest explanation of what deviated and by how much.
function explain(a: Anomaly) {
  const rel = Math.abs((a.current - a.baseline) / a.baseline) * 100;
  const verb = a.direction === "up" ? "급증" : "급감";
  return `${METRIC_LABEL[a.metric] ?? a.metric} ${verb} · 현재 ${fmt(a.metric, a.current)} vs 평소 ${fmt(a.metric, a.baseline)} (${rel.toFixed(0)}% ${a.direction === "up" ? "↑" : "↓"}, ${a.z.toFixed(1)}σ)`;
}

export function Anomalies() {
  const { data, isLoading } = useQuery({ queryKey: ["anomalies"], queryFn: () => fetchAnomalies(60), refetchInterval: 15000 });

  return (
    <div className="content-scroll">
      <div className="anom-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">이상탐지 <span className="hint-inline">임계값 없이 서비스별 평소 대비 통계적 급변을 감지해요</span></span>
          {data && data.length > 0 && <span className="chip err" style={{ marginLeft: "auto" }}><span className="dot" />{data.length}건</span>}
        </div>
        {isLoading ? (
          <Skeleton rows={5} />
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            title="이상 징후가 없어요"
            body="모든 서비스가 평소 범위 안에서 움직이고 있어요. 응답시간·에러율·처리량이 베이스라인에서 3σ 이상 벗어나면 여기에 나타나요."
            hint="60분 기준 · 15초마다 재검사"
          />
        ) : (
          <div className="anom-list">
            {(data ?? []).map((a: Anomaly, i) => (
              <div key={i} className={`anom-card ${a.severity}`}>
                <span className={`anom-sev ${a.severity}`}>{a.severity === "critical" ? "심각" : "주의"}</span>
                <div className="anom-body">
                  <div className="anom-svc">{a.service}</div>
                  <div className="anom-desc">{explain(a)}</div>
                </div>
                <span className={`anom-z ${a.direction}`}>{a.direction === "up" ? "▲" : "▼"} {Math.abs(a.z).toFixed(1)}σ</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
