import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSLO } from "./api";
import type { SLOStatus } from "./api";
import { EmptyState, Skeleton } from "./states";

const WINDOWS = [{ h: 1, label: "1시간" }, { h: 24, label: "24시간" }, { h: 168, label: "7일" }];
const STATUS_LABEL: Record<string, string> = { healthy: "정상", at_risk: "주의", breached: "위반" };

function budgetTone(s: SLOStatus) {
  if (s.status === "breached") return "err";
  if (s.status === "at_risk") return "warn";
  return "ok";
}

export function Slo() {
  const [win, setWin] = useState(24);
  const { data, isLoading } = useQuery({ queryKey: ["slo", win], queryFn: () => fetchSLO(win), refetchInterval: 15000 });
  const breached = (data ?? []).filter((s) => s.status === "breached").length;

  return (
    <div className="content-scroll">
      <div className="slo-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">SLO · 에러 버짓 <span className="hint-inline">가용성 목표 {(data?.[0]?.target ?? 99.9)}% 대비 남은 오류 예산</span></span>
          <div className="segmented" role="tablist" aria-label="기간" style={{ marginLeft: "auto" }}>
            {WINDOWS.map((wd) => (
              <button key={wd.h} role="tab" aria-selected={win === wd.h} className="seg" onClick={() => setWin(wd.h)}>{wd.label}</button>
            ))}
          </div>
        </div>
        {isLoading ? (
          <Skeleton rows={6} />
        ) : (data ?? []).length === 0 ? (
          <EmptyState title="아직 SLO 데이터가 없어요" body="서비스에 트래픽이 쌓이면 가용성 SLO와 에러 버짓이 여기에 계산돼요." />
        ) : (
          <>
            {breached > 0 && <p className="slo-alert">⚠ {breached}개 서비스가 SLO를 위반해 에러 버짓을 모두 소진했어요.</p>}
            <div className="slo-grid">
              {(data ?? []).map((s: SLOStatus) => {
                const tone = budgetTone(s);
                return (
                  <div key={s.service} className={`slo-card ${s.status}`}>
                    <div className="slo-head">
                      <span className="slo-name">{s.service}</span>
                      <span className={`slo-badge ${s.status}`}>{STATUS_LABEL[s.status]}</span>
                    </div>
                    <div className="slo-attain">
                      <span className={`slo-rate ${tone}`}>{s.successRate.toFixed(3)}<i>%</i></span>
                      <span className="slo-target">목표 {s.target}%</span>
                    </div>
                    <div className="slo-budget">
                      <div className="slo-budget-bar"><div className={`slo-budget-fill ${tone}`} style={{ width: `${Math.max(0, Math.min(100, s.budgetRemaining))}%` }} /></div>
                      <div className="slo-budget-label">
                        {s.status === "breached"
                          ? <>에러 버짓 <b>소진</b> · 목표 미달</>
                          : <>에러 버짓 <b>{s.budgetRemaining.toFixed(0)}%</b> 남음</>}
                      </div>
                    </div>
                    <div className="slo-foot">
                      <span>{s.totalReq.toLocaleString()} 요청 · 오류 {s.totalErr.toLocaleString()}</span>
                      {s.hasApdex && <span>Apdex {s.apdex.toFixed(2)}</span>}
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
