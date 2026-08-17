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
  const [svc, setSvc] = useState(""); // "" = 전체
  const minute = Math.floor(Date.now() / 60000);
  const { data, isLoading } = useQuery({
    queryKey: ["overview", minute],
    queryFn: buildOverview,
    refetchInterval: 10000,
  });

  const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const x = data ? data.minutes.map(hm) : [];

  // Scope KPIs/table to the selected service (or all).
  const sel = svc ? data?.perSvcSeries.find((s) => s.service === svc) : null;
  const scopedReq = sel ? sel.requests.reduce((a, b) => a + b, 0) : data?.totalReq ?? 0;
  const scopedErr = sel ? sel.errors.reduce((a, b) => a + b, 0) : data?.totalErr ?? 0;
  const scopedP95 = sel ? Math.max(0, ...sel.p95) : data?.maxP95 ?? 0;
  const errRate = scopedReq > 0 ? (scopedErr / scopedReq) * 100 : 0;
  const rows = svc ? data?.perSvc.filter((s) => s.service === svc) ?? [] : data?.perSvc ?? [];

  // Throughput chart: composition (stacked-by-service) for the whole fleet, or a
  // single service's requests/errors/p95 detail when one is selected.
  const stacked = !svc;
  const top = (data?.perSvcSeries ?? []).slice().sort((a, b) => b.requests.reduce((x, y) => x + y, 0) - a.requests.reduce((x, y) => x + y, 0)).slice(0, 8);
  const chartOption = stacked
    ? {
        backgroundColor: "transparent", color: SVC_PALETTE,
        tooltip: { trigger: "axis", backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
        legend: { textStyle: { color: c.legend }, top: 0, icon: "roundRect", type: "scroll" },
        grid: { left: 48, right: 16, top: 32, bottom: 26 },
        xAxis: { type: "category", data: x, axisLabel: { color: c.axis }, axisLine: { lineStyle: { color: c.split } } },
        yAxis: { type: "value", axisLabel: { color: c.axis }, splitLine: { lineStyle: { color: c.split } } },
        series: top.map((s, i) => ({
          name: s.service, type: "line", stack: "req", areaStyle: { opacity: 0.75 },
          smooth: true, symbol: "none", lineStyle: { width: 0 }, color: SVC_PALETTE[i % SVC_PALETTE.length],
          emphasis: { focus: "series" }, data: s.requests,
        })),
      }
    : {
        backgroundColor: "transparent", color: [c.accent, c.err, c.warn],
        tooltip: { trigger: "axis", backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
        legend: { textStyle: { color: c.legend }, top: 0, icon: "roundRect" },
        grid: { left: 48, right: 16, top: 32, bottom: 26 },
        xAxis: { type: "category", data: x, axisLabel: { color: c.axis }, axisLine: { lineStyle: { color: c.split } } },
        yAxis: [
          { type: "value", axisLabel: { color: c.axis }, splitLine: { lineStyle: { color: c.split } } },
          { type: "value", position: "right", axisLabel: { color: c.axis, formatter: "{value} ms" }, splitLine: { show: false } },
        ],
        series: [
          { name: "요청", type: "bar", data: sel?.requests ?? [], itemStyle: { borderRadius: [2, 2, 0, 0] } },
          { name: "에러", type: "bar", data: sel?.errors ?? [], itemStyle: { borderRadius: [2, 2, 0, 0] } },
          { name: "p95 ms", type: "line", yAxisIndex: 1, smooth: true, symbol: "none", data: sel?.p95 ?? [] },
        ],
      };

  return (
    <div className="dash">
      <div className="span-all dash-toolbar">
        <span className="pane-title">대시보드 {svc && <span className="chip muted">{svc}만 보기</span>}</span>
        <label className="bar" style={{ marginLeft: "auto" }}>
          <span className="field-label">서비스</span>
          <select className="select" value={svc} onChange={(e) => setSvc(e.target.value)} aria-label="서비스 필터">
            <option value="">전체 서비스</option>
            {(data?.perSvc ?? []).map((s) => <option key={s.service} value={s.service}>{s.service}</option>)}
          </select>
        </label>
      </div>

      {/* Live hero — scoped to the selected service. */}
      <div className="span-all"><SpeedBand service={svc || undefined} /></div>

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
            <Kpi label={`총 요청 · ${svc || "전체"} · 최근 1시간`} value={scopedReq.toLocaleString()} />
            <Kpi label="에러율" value={errRate.toFixed(errRate < 10 ? 2 : 1)} unit="%" tone={errRate > 5 ? "err" : errRate > 1 ? "warn" : "ok"} />
            <ApdexCard service={svc || data.perSvc[0]?.service} />
            <Kpi label="활성 서비스" value={svc ? "1" : String(data.perSvc.length)} />
            <Kpi label="최대 p95" value={scopedP95.toLocaleString()} unit="ms" tone={scopedP95 > 1000 ? "warn" : undefined} />
          </section>

          <section className="dash-panel">
            <div className="hm-fixed"><Heatmap service={svc || undefined} /></div>
          </section>
          <section className="dash-panel">
            <div className="section-label">{stacked ? "처리량 구성 · 서비스별" : `${svc} · 요청·에러·지연`}</div>
            <div style={{ height: 260 }}>
              <ReactECharts option={chartOption} style={{ height: "100%" }} notMerge />
            </div>
          </section>

          <section className="dash-panel span-all">
            <div className="section-label">서비스 헬스</div>
            <table className="tbl">
              <thead>
                <tr><th>서비스</th><th className="r">요청</th><th className="r">에러</th><th className="r">p95</th><th>상태</th></tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const er = s.requests > 0 ? (s.errors / s.requests) * 100 : 0;
                  const tone = er > 5 ? "err" : er > 1 ? "warn" : "ok";
                  return (
                    <tr key={s.service} tabIndex={0} onClick={() => setSvc(s.service === svc ? "" : s.service)} style={{ cursor: "pointer" }}>
                      <td className="svc">{s.service}</td>
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
