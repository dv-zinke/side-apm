import { useQuery } from "@tanstack/react-query";
import { fetchMonitors, fetchMonitorTimeline } from "./api";
import type { Monitor } from "./api";
import { EmptyState, Skeleton } from "./states";

function uptimeTone(pct: number) { return pct >= 99.9 ? "ok" : pct >= 99 ? "warn" : "err"; }

// Compact uptime bar — one segment per timeline bucket, green=up / red=down.
function UptimeBar({ monitor }: { monitor: string }) {
  const { data } = useQuery({ queryKey: ["uptime", monitor], queryFn: () => fetchMonitorTimeline(monitor), refetchInterval: 15000 });
  const buckets = (data ?? []).slice(-60);
  if (buckets.length === 0) return <div className="up-bar up-bar-empty" aria-hidden />;
  return (
    <div className="up-bar" role="img" aria-label={`최근 가동 상태 ${buckets.length}구간`}>
      {buckets.map((b, i) => (
        <span key={i} className={`up-seg ${b.up ? "ok" : "down"}`} title={`${new Date(b.time).toLocaleTimeString()} · ${b.up ? "정상" : "다운"} · ${b.latencyMs.toFixed(0)}ms`} />
      ))}
    </div>
  );
}

export function Synthetics() {
  const { data, isLoading } = useQuery({ queryKey: ["synthetics"], queryFn: fetchMonitors, refetchInterval: 10000 });

  return (
    <div className="content-scroll">
      <div className="synth-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">가동 모니터링 · 신서틱 <span className="hint-inline">엔드포인트를 주기적으로 프로빙해요</span></span>
          {data && <span className="chip muted" style={{ marginLeft: "auto" }}><span className="dot" />{data.length}개</span>}
        </div>
        {isLoading ? (
          <Skeleton rows={5} />
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            title="아직 모니터가 없어요"
            body="APM_SYNTHETICS로 프로빙할 URL을 지정하면(name|url,…) 업타임·응답시간이 여기에 모여요."
          />
        ) : (
          <div className="synth-grid">
            {(data ?? []).map((m: Monitor) => (
              <section key={m.monitor} className="synth-card">
                <div className="synth-head">
                  <span className={`chip ${m.up ? "ok" : "err"}`}><span className="dot" />{m.up ? "정상" : "다운"}</span>
                  <div className="synth-title">
                    <span className="synth-name">{m.monitor}</span>
                    <span className="synth-url" title={m.url}>{m.url}</span>
                  </div>
                  <span className={`synth-uptime ${uptimeTone(m.uptime)}`}>{m.uptime.toFixed(2)}%</span>
                </div>
                <UptimeBar monitor={m.monitor} />
                <div className="synth-foot">
                  <span>응답 <b>{m.latencyMs.toFixed(0)}ms</b> · 평균 {m.avgLatencyMs.toFixed(0)}ms</span>
                  <span>HTTP {m.status || "—"} · {m.checks.toLocaleString()}회 점검</span>
                </div>
                {!m.up && m.lastErr && <div className="synth-err">{m.lastErr}</div>}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
