import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { fetchServices, fetchRED } from "./api";
import type { REDPoint } from "./api";
import { Skeleton, EmptyState } from "./states";
import { useTheme } from "./theme";
import { chartColors } from "./chart";
import { SpeedBand } from "./SpeedBand";
import { Heatmap } from "./Heatmap";
import { ApdexCard } from "./Apdex";

type SvcRoll = { service: string; requests: number; errors: number; p95: number };
type SvcSeries = { service: string; requests: number[]; errors: number[]; p95: number[] };
type Overview = {
  minutes: string[];
  requests: number[];
  errors: number[];
  p95: number[];
  perSvc: SvcRoll[];
  perSvcSeries: SvcSeries[]; // aligned to minutes
  totalReq: number;
  totalErr: number;
  maxP95: number;
};

// Fan out RED across every service, then fold into one global timeline.
async function buildOverview(): Promise<Overview> {
  const svcs = await fetchServices();
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const reds = await Promise.all(
    svcs.map((s) => fetchRED(s, from, to).then((pts) => [s, pts] as const).catch(() => [s, [] as REDPoint[]] as const))
  );

  const byMinute = new Map<string, { req: number; err: number; p95: number }>();
  const perSvc: SvcRoll[] = [];
  for (const [service, pts] of reds) {
    let req = 0, err = 0, p95 = 0;
    for (const p of pts) {
      req += p.requestCount;
      err += p.errorCount;
      p95 = Math.max(p95, p.p95Ms);
      const m = byMinute.get(p.minute) ?? { req: 0, err: 0, p95: 0 };
      m.req += p.requestCount; m.err += p.errorCount; m.p95 = Math.max(m.p95, p.p95Ms);
      byMinute.set(p.minute, m);
    }
    if (req > 0) perSvc.push({ service, requests: req, errors: err, p95 });
  }
  perSvc.sort((a, b) => b.requests - a.requests);

  const minutes = [...byMinute.keys()].sort();
  const mIdx = new Map(minutes.map((m, i) => [m, i]));
  // Per-service series aligned to the shared minute axis (for the stacked chart).
  const perSvcSeries: SvcSeries[] = reds
    .filter(([, pts]) => pts.some((p) => p.requestCount > 0))
    .map(([service, pts]) => {
      const requests = new Array(minutes.length).fill(0);
      const errors = new Array(minutes.length).fill(0);
      const p95 = new Array(minutes.length).fill(0);
      for (const p of pts) {
        const i = mIdx.get(p.minute);
        if (i === undefined) continue;
        requests[i] = p.requestCount; errors[i] = p.errorCount; p95[i] = Math.round(p.p95Ms);
      }
      return { service, requests, errors, p95 };
    });
  return {
    minutes,
    requests: minutes.map((m) => byMinute.get(m)!.req),
    errors: minutes.map((m) => byMinute.get(m)!.err),
    p95: minutes.map((m) => Math.round(byMinute.get(m)!.p95)),
    perSvc,
    perSvcSeries,
    totalReq: perSvc.reduce((s, x) => s + x.requests, 0),
    totalErr: perSvc.reduce((s, x) => s + x.errors, 0),
    maxP95: Math.round(perSvc.reduce((m, x) => Math.max(m, x.p95), 0)),
  };
}

function Kpi({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: "ok" | "warn" | "err" }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value${tone ? " " + tone : ""}`}>
        {value}{unit && <span className="kpi-unit">{unit}</span>}
      </div>
    </div>
  );
}

// Distinct hues for the stacked-by-service throughput bands.
const SVC_PALETTE = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#f472b6", "#60a5fa", "#f87171", "#2dd4bf"];

export function Dashboard() {
  const { theme } = useTheme();
  const c = chartColors(theme);
  const [off, setOff] = useState<Set<string>>(new Set()); // services toggled OFF
  const minute = Math.floor(Date.now() / 60000);
  const { data, isLoading } = useQuery({
    queryKey: ["overview", minute],
    queryFn: buildOverview,
    refetchInterval: 10000,
  });

  const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const x = data ? data.minutes.map(hm) : [];

  // Multi-select: every service shown, individually toggled on/off. A stable
  // color per service (by rank) keeps the toggle chips and chart bands aligned.
  const ranked = (data?.perSvcSeries ?? []).slice().sort((a, b) => b.requests.reduce((s, v) => s + v, 0) - a.requests.reduce((s, v) => s + v, 0));
  const colorOf = (svc: string) => SVC_PALETTE[Math.max(0, ranked.findIndex((s) => s.service === svc)) % SVC_PALETTE.length];
  const on = (svc: string) => !off.has(svc);
  const enabled = (data?.perSvc ?? []).map((s) => s.service).filter(on);
  const toggle = (svc: string) => setOff((prev) => { const n = new Set(prev); n.has(svc) ? n.delete(svc) : n.add(svc); return n; });
  const setAll = (allOn: boolean) => setOff(allOn ? new Set() : new Set((data?.perSvc ?? []).map((s) => s.service)));

  // KPIs/table aggregate over the enabled services only.
  const enSeries = ranked.filter((s) => on(s.service));
  const scopedReq = enSeries.reduce((a, s) => a + s.requests.reduce((x, y) => x + y, 0), 0);
  const scopedErr = enSeries.reduce((a, s) => a + s.errors.reduce((x, y) => x + y, 0), 0);
  const scopedP95 = enSeries.reduce((m, s) => Math.max(m, ...s.p95), 0);
  const errRate = scopedReq > 0 ? (scopedErr / scopedReq) * 100 : 0;
  const rows = (data?.perSvc ?? []).filter((s) => on(s.service));

  // Throughput = stacked-by-service composition of the ENABLED services (clearly
  // distinct from the RED dashboard's single-service bars+line).
  const chartOption = {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
    legend: { show: false },
    grid: { left: 48, right: 16, top: 12, bottom: 26 },
    xAxis: { type: "category", data: x, axisLabel: { color: c.axis }, axisLine: { lineStyle: { color: c.split } } },
    yAxis: { type: "value", axisLabel: { color: c.axis }, splitLine: { lineStyle: { color: c.split } } },
    series: enSeries.slice(0, 8).map((s) => ({
      name: s.service, type: "line", stack: "req", areaStyle: { opacity: 0.75 },
      smooth: true, symbol: "none", lineStyle: { width: 0 }, color: colorOf(s.service),
      emphasis: { focus: "series" }, data: s.requests,
    })),
  };

  return (
    <div className="dash">
      <div className="span-all dash-toolbar">
        <span className="pane-title">대시보드</span>
        {data && data.perSvc.length > 0 && (
          <div className="svc-toggles">
            {data.perSvc.map((s) => (
              <button key={s.service} className={`svc-toggle${on(s.service) ? " on" : ""}`} onClick={() => toggle(s.service)} aria-pressed={on(s.service)}>
                <span className="svc-swatch" style={{ background: on(s.service) ? colorOf(s.service) : "var(--tx-faint)" }} />
                {s.service}
              </button>
            ))}
            <button className="svc-toggle-all" onClick={() => setAll(enabled.length < (data.perSvc.length))}>
              {enabled.length < data.perSvc.length ? "전체 켜기" : "전체 끄기"}
            </button>
          </div>
        )}
      </div>

      {/* Live hero — scoped to the enabled services. */}
      <div className="span-all"><SpeedBand services={enabled.length === (data?.perSvc.length ?? 0) ? undefined : enabled} /></div>

      {isLoading || !data ? (
        <div className="span-all"><Skeleton rows={6} /></div>
      ) : data.perSvc.length === 0 ? (
        <div className="span-all">
          <EmptyState
            title="아직 집계할 트래픽이 없어요"
            body="에이전트가 트레이스를 보내기 시작하면 처리량·에러·지연 지표가 여기에 모여요."
            hint="최근 1시간 기준"
          />
        </div>
      ) : (
        <>
          <section className="kpi-grid span-all">
            <Kpi label={`총 요청 · ${enabled.length === data.perSvc.length ? "전체" : `${enabled.length}개 서비스`} · 최근 1시간`} value={scopedReq.toLocaleString()} />
            <Kpi label="에러율" value={errRate.toFixed(errRate < 10 ? 2 : 1)} unit="%" tone={errRate > 5 ? "err" : errRate > 1 ? "warn" : "ok"} />
            <ApdexCard service={rows[0]?.service} />
            <Kpi label="켜진 서비스" value={`${enabled.length}/${data.perSvc.length}`} />
            <Kpi label="최대 p95" value={scopedP95.toLocaleString()} unit="ms" tone={scopedP95 > 1000 ? "warn" : undefined} />
          </section>

          <section className="dash-panel">
            <div className="hm-fixed"><Heatmap services={enabled.length === data.perSvc.length ? undefined : enabled} /></div>
          </section>
          <section className="dash-panel">
            <div className="section-label">처리량 구성 · 켜진 서비스 {enabled.length}개</div>
            <div style={{ height: 260 }}>
              <ReactECharts option={chartOption} style={{ height: "100%" }} notMerge />
            </div>
          </section>

          <section className="dash-panel span-all">
            <div className="section-label">서비스 헬스 <span className="hint-inline">행을 클릭하면 켜기/끄기</span></div>
            <table className="tbl">
              <thead>
                <tr><th>서비스</th><th className="r">요청</th><th className="r">에러</th><th className="r">p95</th><th>상태</th></tr>
              </thead>
              <tbody>
                {(data.perSvc).map((s) => {
                  const er = s.requests > 0 ? (s.errors / s.requests) * 100 : 0;
                  const tone = er > 5 ? "err" : er > 1 ? "warn" : "ok";
                  return (
                    <tr key={s.service} tabIndex={0} onClick={() => toggle(s.service)} className={on(s.service) ? "" : "row-off"} style={{ cursor: "pointer" }}>
                      <td className="svc"><span className="svc-swatch" style={{ background: on(s.service) ? colorOf(s.service) : "var(--tx-faint)", marginRight: 6 }} />{s.service}</td>
                      <td className="r">{s.requests.toLocaleString()}</td>
                      <td className="r">{s.errors.toLocaleString()}</td>
                      <td className="r">{Math.round(s.p95).toLocaleString()} ms</td>
                      <td><span className={`chip ${tone}`}><span className="dot" />{er.toFixed(1)}%</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
