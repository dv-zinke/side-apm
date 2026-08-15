import { useQuery } from "@tanstack/react-query";
import { fetchRumOverview, fetchRumGroup } from "./api";
import type { RumCount } from "./api";
import { EmptyState, Skeleton } from "./states";

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

export function Rum() {
  const { data: ov, isLoading } = useQuery({ queryKey: ["rum-overview"], queryFn: fetchRumOverview, refetchInterval: 10000 });
  const empty = ov && ov.sessions === 0 && ov.pageviews === 0;

  return (
    <div className="content-scroll">
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
            <section className="span-all"><GroupCard title="HTTP 리소스" kind="resources" valueLabel="호출" /></section>
          </>
        )}
      </div>
    </div>
  );
}
