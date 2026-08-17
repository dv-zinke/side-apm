import { useQuery } from "@tanstack/react-query";
import { fetchHealth } from "./api";
import type { ServiceHealth } from "./api";
import { useNav } from "./nav";
import { Skeleton } from "./states";

const STATUS_LABEL: Record<string, string> = { healthy: "정상", degraded: "저하", down: "장애", idle: "유휴" };

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="hz-stat">
      <div className={`hz-stat-val${tone ? " " + tone : ""}`}>{value}</div>
      <div className="hz-stat-label">{label}</div>
    </div>
  );
}

function ms(v: number) { return v >= 1000 ? (v / 1000).toFixed(1) + "s" : v.toFixed(0) + "ms"; }

export function Health() {
  const { setView } = useNav();
  const { data, isLoading } = useQuery({ queryKey: ["health"], queryFn: fetchHealth, refetchInterval: 8000 });
  const s = data?.summary;

  return (
    <div className="content-scroll">
      <div className="hz-view">
        {isLoading || !s ? (
          <Skeleton rows={8} />
        ) : (
          <>
            <section className="hz-summary">
              <Stat label="정상" value={s.healthy} tone="ok" />
              <Stat label="저하" value={s.degraded} tone={s.degraded ? "warn" : undefined} />
              <Stat label="장애" value={s.down} tone={s.down ? "err" : undefined} />
              <button className="hz-stat as-btn" onClick={() => setView("alerts")}>
                <div className={`hz-stat-val${s.activeAlerts ? " err" : ""}`}>{s.activeAlerts}</div>
                <div className="hz-stat-label">활성 알림</div>
              </button>
              <button className="hz-stat as-btn" onClick={() => setView("anomaly")}>
                <div className={`hz-stat-val${s.anomalies ? " warn" : ""}`}>{s.anomalies}</div>
                <div className="hz-stat-label">이상 징후</div>
              </button>
              <button className="hz-stat as-btn" onClick={() => setView("synth")}>
                <div className={`hz-stat-val${s.monitorsDown ? " err" : " ok"}`}>{s.monitorsUp}/{s.monitorsTotal}</div>
                <div className="hz-stat-label">가동 모니터</div>
              </button>
            </section>

            <div className="section-label">서비스 헬스 <span className="hint-inline">카드를 클릭하면 RED 대시보드</span></div>
            <section className="hz-grid">
              {data.services.map((h: ServiceHealth) => (
                <button key={h.service} className={`hz-card ${h.status}`} onClick={() => setView("red")}>
                  <div className="hz-card-head">
                    <span className={`hz-dot ${h.status}`} />
                    <span className="hz-name">{h.service}</span>
                    <span className={`hz-badge ${h.status}`}>{STATUS_LABEL[h.status]}</span>
                  </div>
                  <div className="hz-metrics">
                    <span><b>{h.reqPerMin.toFixed(0)}</b><i>req/분</i></span>
                    <span className={h.errorRate >= 5 ? "err" : h.errorRate >= 1 ? "warn" : ""}><b>{h.errorRate.toFixed(1)}%</b><i>에러</i></span>
                    <span className={h.p95Ms >= 1500 ? "err" : h.p95Ms >= 600 ? "warn" : ""}><b>{ms(h.p95Ms)}</b><i>p95</i></span>
                  </div>
                  {(h.alerting || h.anomalies > 0) && (
                    <div className="hz-flags">
                      {h.alerting && <span className="hz-flag err">● 알림</span>}
                      {h.anomalies > 0 && <span className="hz-flag warn">▲ 이상 {h.anomalies}</span>}
                    </div>
                  )}
                </button>
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
