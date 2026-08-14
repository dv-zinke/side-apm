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
type Overview = {
  minutes: string[];
  requests: number[];
  errors: number[];
  p95: number[];
  perSvc: SvcRoll[];
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
  return {
    minutes,
    requests: minutes.map((m) => byMinute.get(m)!.req),
    errors: minutes.map((m) => byMinute.get(m)!.err),
    p95: minutes.map((m) => Math.round(byMinute.get(m)!.p95)),
    perSvc,
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

export function Dashboard() {
  const { theme } = useTheme();
  const c = chartColors(theme);
  const minute = Math.floor(Date.now() / 60000);
  const { data, isLoading } = useQuery({
    queryKey: ["overview", minute],
    queryFn: buildOverview,
    refetchInterval: 10000,
  });

  const errRate = data && data.totalReq > 0 ? (data.totalErr / data.totalReq) * 100 : 0;
  // Local HH:MM so the axis matches the heatmap's wall clock (not UTC).
  const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const x = data ? data.minutes.map(hm) : [];
  const option = {
    backgroundColor: "transparent",
    color: [c.accent, c.err, c.warn],
    tooltip: { trigger: "axis", backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
    legend: { textStyle: { color: c.legend }, top: 0, icon: "roundRect" },
    grid: { left: 48, right: 16, top: 32, bottom: 26 },
    xAxis: { type: "category", data: x, axisLabel: { color: c.axis }, axisLine: { lineStyle: { color: c.split } } },
    yAxis: [
      { type: "value", axisLabel: { color: c.axis }, splitLine: { lineStyle: { color: c.split } } },
      { type: "value", position: "right", axisLabel: { color: c.axis, formatter: "{value} ms" }, splitLine: { show: false } },
    ],
    series: [
      { name: "요청", type: "bar", data: data?.requests ?? [], itemStyle: { borderRadius: [2, 2, 0, 0] } },
      { name: "에러", type: "bar", data: data?.errors ?? [], itemStyle: { borderRadius: [2, 2, 0, 0] } },
      { name: "p95 ms (최대)", type: "line", yAxisIndex: 1, smooth: true, symbol: "none", data: data?.p95 ?? [] },
    ],
  };

  return (
    <div className="dash">
      {/* Live hero — always streaming, independent of the RED rollup */}
      <div className="span-all"><SpeedBand /></div>

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
            <Kpi label="총 요청 · 최근 1시간" value={data.totalReq.toLocaleString()} />
            <Kpi label="에러율" value={errRate.toFixed(errRate < 10 ? 2 : 1)} unit="%" tone={errRate > 5 ? "err" : errRate > 1 ? "warn" : "ok"} />
            <ApdexCard service={data.perSvc[0]?.service} />
            <Kpi label="활성 서비스" value={String(data.perSvc.length)} />
            <Kpi label="최대 p95" value={data.maxP95.toLocaleString()} unit="ms" tone={data.maxP95 > 1000 ? "warn" : undefined} />
          </section>

          <section className="dash-panel">
            <div className="hm-fixed"><Heatmap /></div>
          </section>
          <section className="dash-panel">
            <div className="section-label">처리량 · 에러 · 지연</div>
            <div style={{ height: 260 }}>
              <ReactECharts option={option} style={{ height: "100%" }} notMerge />
            </div>
          </section>

          <section className="dash-panel span-all">
            <div className="section-label">서비스 헬스</div>
            <table className="tbl">
              <thead>
                <tr><th>서비스</th><th className="r">요청</th><th className="r">에러</th><th className="r">p95</th><th>상태</th></tr>
              </thead>
              <tbody>
                {data.perSvc.map((s) => {
                  const er = s.requests > 0 ? (s.errors / s.requests) * 100 : 0;
                  const tone = er > 5 ? "err" : er > 1 ? "warn" : "ok";
                  return (
                    <tr key={s.service} style={{ cursor: "default" }}>
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
