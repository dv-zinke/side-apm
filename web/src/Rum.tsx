import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchRumOverview, fetchRumGroup, fetchReplays } from "./api";
import type { RumCount, ReplayMeta } from "./api";
import { EmptyState, Skeleton } from "./states";
import { ReplayModal } from "./ReplayModal";

function Kpi({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: "ok" | "warn" | "err" }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value${tone ? " " + tone : ""}`}>{value}{unit && <span className="kpi-unit">{unit}</span>}</div>
    </div>
  );
}
const lcpTone = (ms: number) => (ms > 4000 ? "err" : ms > 2500 ? "warn" : "ok");

function GroupCard({ title, kind, valueLabel }: { title: string; kind: "clicks" | "errors" | "resources"; valueLabel: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["rum", kind], queryFn: () => fetchRumGroup(kind, 20), refetchInterval: 10000 });
  return (
    <section className="dash-panel">
      <div className="section-label">{title}</div>
      {isLoading ? <Skeleton rows={6} /> : (data ?? []).length === 0 ? (
        <div className="log-empty">아직 {title} 데이터가 없어요.</div>
      ) : (
        <table className="tbl">
          <thead><tr><th>{kind === "errors" ? "메시지" : kind === "resources" ? "URL" : "요소"}</th><th className="r">{valueLabel}</th>{kind === "resources" && <th className="r">평균</th>}</tr></thead>
          <tbody>
            {(data ?? []).map((c: RumCount, i) => (
              <tr key={i} style={{ cursor: "default" }}>
                <td className={kind === "clicks" ? "svc" : "db-stmt"} title={c.key}>{c.key}</td>
                <td className="r">{c.count.toLocaleString()}</td>
                {kind === "resources" && <td className="r">{c.avgMs.toFixed(0)} ms</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ReplaysCard({ onPlay }: { onPlay: (m: ReplayMeta) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ["replays"], queryFn: () => fetchReplays(20), refetchInterval: 10000 });
  return (
    <section className="dash-panel span-all">
      <div className="section-label">세션 리플레이 · 에러 비디오 <span className="hint-inline">행을 클릭하면 재생</span></div>
      {isLoading ? <Skeleton rows={4} /> : (data ?? []).length === 0 ? (
        <div className="log-empty">아직 녹화된 리플레이가 없어요. 프론트 에러가 발생하면 직전 화면이 자동 저장돼요.</div>
      ) : (
        <table className="tbl">
          <thead><tr><th>시각</th><th>페이지</th><th>에러</th></tr></thead>
          <tbody>
            {(data ?? []).map((m) => (
              <tr key={m.id} tabIndex={0} onClick={() => onPlay(m)} onKeyDown={(e) => { if (e.key === "Enter") onPlay(m); }}>
                <td className="log-time">{m.time.slice(0, 19).replace("T", " ")}</td>
                <td className="svc">{m.page}</td>
                <td className="db-stmt" style={{ color: "var(--err)" }} title={m.message}>{m.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Rum() {
  const { data: ov, isLoading } = useQuery({ queryKey: ["rum-overview"], queryFn: fetchRumOverview, refetchInterval: 10000 });
  const empty = ov && ov.sessions === 0 && ov.pageviews === 0;
  const [replay, setReplay] = useState<ReplayMeta | null>(null);

  return (
    <div className="content-scroll">
      {replay && <ReplayModal meta={replay} onClose={() => setReplay(null)} />}
      <div className="dash">
        {isLoading ? (
          <div className="span-all"><Skeleton rows={4} /></div>
        ) : empty ? (
          <div className="span-all">
            <EmptyState
              title="아직 브라우저 데이터가 없어요"
              body="페이지에 rum.js를 넣으면 세션·클릭·에러·성능(Core Web Vitals)이 여기에 모여요. 이 콘솔도 자기 자신을 관측 중이에요."
              hint='<script src="/rum.js" data-endpoint="…4318">'
            />
          </div>
        ) : (
          <>
            <section className="kpi-grid span-all">
              <Kpi label="세션" value={(ov?.sessions ?? 0).toLocaleString()} />
              <Kpi label="페이지뷰" value={(ov?.pageviews ?? 0).toLocaleString()} />
              <Kpi label="프론트 에러" value={(ov?.errors ?? 0).toLocaleString()} tone={ov && ov.errors > 0 ? "warn" : "ok"} />
              <Kpi label="LCP p75" value={ov ? Math.round(ov.lcpP75).toLocaleString() : "—"} unit="ms" tone={ov ? lcpTone(ov.lcpP75) : undefined} />
              <Kpi label="INP p75" value={ov ? Math.round(ov.inpP75).toLocaleString() : "—"} unit="ms" />
            </section>
            <GroupCard title="많이 클릭한 요소" kind="clicks" valueLabel="클릭" />
            <GroupCard title="프론트엔드 에러" kind="errors" valueLabel="발생" />
            <ReplaysCard onPlay={setReplay} />
            <section className="span-all"><GroupCard title="HTTP 리소스" kind="resources" valueLabel="호출" /></section>
          </>
        )}
      </div>
    </div>
  );
}
