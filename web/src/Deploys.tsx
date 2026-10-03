import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { fetchDeployImpacts, fetchServices } from "./api";
import type { DeployImpact } from "./api";
import { EmptyState, Skeleton, ErrorState } from "./states";
import { useNav } from "./nav";
import { replaceParams } from "./urlState";

const WINDOWS = [{ min: 15, label: "±15분" }, { min: 30, label: "±30분" }, { min: 60, label: "±1시간" }];

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const ms = (n: number) => (n >= 1000 ? (n / 1000).toFixed(2) + "s" : n.toFixed(0) + "ms");

// A metric's before→after verdict. Latency compares by %, error rate by points.
function tone(before: number, after: number, kind: "err" | "p95"): "worse" | "better" | "same" {
  const d = kind === "err" ? after - before : before > 0 ? ((after - before) / before) * 100 : 0;
  const thr = kind === "err" ? 0.5 : 15;
  if (d > thr) return "worse";
  if (d < -thr) return "better";
  return "same";
}
const TONE_CLS: Record<string, string> = { worse: "err", better: "ok", same: "" };

function Delta({ before, after, kind }: { before: number; after: number; kind: "err" | "p95" }) {
  const t = tone(before, after, kind);
  // Arrow follows the verdict, not the raw value — so "변화 없음" never shows ↑/↓.
  const arrow = t === "same" ? "→" : t === "worse" ? "↑" : "↓";
  const fmt = kind === "err" ? (v: number) => v.toFixed(2) + "%" : ms;
  return (
    <div className="dp-metric">
      <span className="dp-metric-label">{kind === "err" ? "에러율" : "p95 지연"}</span>
      <span className="dp-metric-vals">
        <span className="dp-before">{fmt(before)}</span>
        <span className={`dp-arrow ${TONE_CLS[t]}`}>{arrow}</span>
        <span className={`dp-after ${TONE_CLS[t]}`}>{fmt(after)}</span>
      </span>
    </div>
  );
}

function verdict(d: DeployImpact): { label: string; cls: string; mark: string } {
  const e = tone(d.beforeErrRate, d.afterErrRate, "err");
  const p = tone(d.beforeP95, d.afterP95, "p95");
  if (e === "worse" || p === "worse") return { label: "회귀 의심", cls: "err", mark: "▲" };
  if (e === "better" || p === "better") return { label: "개선", cls: "ok", mark: "▼" };
  return { label: "변화 없음", cls: "muted", mark: "＝" };
}

export function Deploys() {
  const { setView } = useNav();
  const [service, setService] = useState("");
  const [win, setWin] = useState(30);
  // Drill into the service's RED chart (deploy markers overlaid) for this deploy.
  const openRED = (svc: string) => { replaceParams({ redsvc: svc }); setView("red"); };
  const { data: services } = useQuery({ queryKey: ["services"], queryFn: fetchServices, refetchInterval: 30000 });
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["deploy-impacts", service, win],
    queryFn: () => fetchDeployImpacts(service, win),
    refetchInterval: 30000,
    placeholderData: keepPreviousData,
  });
  const deploys = data ?? [];
  const regressions = deploys.filter((d) => verdict(d).label === "회귀 의심").length;

  return (
    <div className="content-scroll">
      <div className="dp-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">배포 추적 <span className="hint-inline">{deploys.length}개 배포 · 전후 {win}분 비교{regressions > 0 && <> · <b className="err-regress-count">회귀 {regressions}</b></>}</span></span>
          <div className="bar" style={{ marginLeft: "auto", gap: "var(--sp-3)" }}>
            <select className="select" value={service} onChange={(e) => setService(e.target.value)} aria-label="서비스 필터">
              <option value="">전체 서비스</option>
              {(services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <div className="segmented" role="radiogroup" aria-label="비교 구간">
              {WINDOWS.map((wd) => <button key={wd.min} role="radio" aria-checked={win === wd.min} className="seg" onClick={() => setWin(wd.min)}>{wd.label}</button>)}
            </div>
          </div>
        </div>
        {isError && !data ? (
          <ErrorState error={new Error("배포 데이터를 불러오지 못했어요")} onRetry={() => refetch()} />
        ) : isLoading && !data ? (
          <Skeleton rows={6} />
        ) : deploys.length === 0 ? (
          <EmptyState title="아직 기록된 배포가 없어요"
            body="배포 시 마커를 보내면(CI에서 한 줄), 각 배포 전후의 에러율·지연 변화를 여기서 비교해요."
            hint={`curl -XPOST :8080/api/v1/deploys -d '{"service":"…","version":"…"}'`} />
        ) : (
          <div className="dp-list">
            {deploys.map((d, i) => {
              const v = verdict(d);
              return (
                <div key={i} className="dp-card" role="button" tabIndex={0}
                  title={`${d.service} RED 차트 열기`}
                  onClick={() => openRED(d.service)}
                  onKeyDown={(e) => { if (e.key === "Enter") openRED(d.service); }}>
                  <div className="dp-head">
                    <span className="dp-svc">{d.service}</span>
                    <span className="dp-ver">{d.version}</span>
                    <span className={`chip ${v.cls} dp-verdict`}><span aria-hidden className="dp-mark">{v.mark}</span> {v.label}</span>
                    <span className="dp-time">{hm(d.time)} · {ago(d.time)}</span>
                  </div>
                  {d.description && <div className="dp-desc">{d.description}</div>}
                  <div className="dp-metrics">
                    <Delta before={d.beforeErrRate} after={d.afterErrRate} kind="err" />
                    <Delta before={d.beforeP95} after={d.afterP95} kind="p95" />
                    {!d.afterComplete && <span className="dp-partial" title={`배포 후 ${d.windowMin}분이 아직 안 지났어요`}>집계 중…</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
