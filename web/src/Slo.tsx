import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { fetchSLO } from "./api";
import type { SLOStatus } from "./api";
import { EmptyState, Skeleton } from "./states";
import { TimeRangePicker, StreamStatus, resolveSel, selLabel, DEFAULT_SEL, type TimeSel } from "./range";

const STATUS_LABEL: Record<string, string> = { healthy: "정상", at_risk: "주의", breached: "위반" };

function toneOf(status: string) {
  if (status === "breached") return "err";
  if (status === "at_risk") return "warn";
  return "ok";
}

export function Slo() {
  const [sel, setSel] = useState<TimeSel>(DEFAULT_SEL);
  const minute = Math.floor(Date.now() / 60000);
  const win = resolveSel(sel, minute * 60000);
  const { data, isLoading } = useQuery({
    queryKey: ["slo", win.fromISO, win.toISO],
    queryFn: () => fetchSLO(win.fromISO, win.toISO),
    refetchInterval: win.live ? 15000 : false,
    placeholderData: keepPreviousData,
  });
  const breached = (data ?? []).filter((s) => s.status === "breached").length;

  return (
    <div className="content-scroll">
      <div className="slo-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">SLO · 에러 버짓 <span className="hint-inline">{selLabel(sel)} · 가용성 목표 {(data?.[0]?.target ?? 99.9)}% 대비 남은 오류 예산</span></span>
          <div style={{ marginLeft: "auto" }}>
            <TimeRangePicker value={sel} onChange={setSel} />
          </div>
        </div>
        {isLoading ? (
          <Skeleton rows={6} />
        ) : (data ?? []).length === 0 ? (
          <EmptyState title="아직 SLO 데이터가 없어요" body="서비스에 트래픽이 쌓이면 가용성 SLO와 에러 버짓이 여기에 계산돼요." hint={selLabel(sel)} />
        ) : (
          <>
            <StreamStatus sel={sel} everyLabel="15초마다 갱신" />
            {breached > 0 && <p className="slo-alert" role="status">⚠ {selLabel(sel)} 기준 {breached}개 서비스가 SLO를 위반했어요.</p>}
            <div className="slo-grid">
              {(data ?? []).map((s: SLOStatus) => {
                const availTone = toneOf(s.availStatus);
                // Distinguish which SLI breached so a 100% availability card
                // doesn't read as a contradiction when only latency is failing.
                const badgeLabel = s.status === "breached"
                  ? (s.availStatus === "breached" ? "가용성 위반" : "지연 위반")
                  : s.status === "at_risk"
                    ? (s.availStatus === "at_risk" ? "가용성 주의" : "지연 주의")
                    : STATUS_LABEL[s.status];
                return (
                  <div key={s.service} className={`slo-card ${s.status}`}>
                    <div className="slo-head">
                      <span className="slo-name">{s.service}</span>
                      <span className={`slo-badge ${s.status}`}>{badgeLabel}</span>
                    </div>
                    <div className="slo-attain">
                      <span className={`slo-rate ${availTone}`}>{s.successRate.toFixed(3)}<i>%</i></span>
                      <span className="slo-target">가용성 목표 {s.target}%</span>
                    </div>
                    <div className="slo-budget">
                      <div className="slo-budget-bar"><div className={`slo-budget-fill ${availTone}`} style={{ width: `${Math.max(0, Math.min(100, s.budgetRemaining))}%` }} /></div>
                      <div className="slo-budget-label">
                        {s.availStatus === "breached"
                          ? <>에러 버짓 <b>소진</b>{s.budgetOverBy >= 1.5 && <> · 예산 <b>{s.budgetOverBy.toFixed(1)}배</b> 초과</>}</>
                          : <>에러 버짓 <b>{s.budgetRemaining.toFixed(0)}%</b> 남음</>}
                      </div>
                    </div>
                    {s.hasLatency && (
                      <div className="slo-lat">
                        <span className="slo-lat-label">지연 SLI</span>
                        <span className={`slo-lat-val ${toneOf(s.latencyStatus)}`}>p95 {s.p95Ms >= 1000 ? (s.p95Ms / 1000).toFixed(1) + "s" : s.p95Ms.toFixed(0) + "ms"}</span>
                        {s.latencyStatus !== "healthy" && <span className={`slo-lat-flag ${toneOf(s.latencyStatus)}`}>{s.latencyStatus === "breached" ? "지연 목표 미달" : "지연 주의"}</span>}
                      </div>
                    )}
                    <div className="slo-foot">
                      <span>{s.totalReq.toLocaleString()} 요청 · 오류 {s.totalErr.toLocaleString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
