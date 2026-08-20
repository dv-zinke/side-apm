import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import ReactECharts from "echarts-for-react";
import { fetchErrorGroups, fetchErrorDetail } from "./api";
import type { ErrorGroup, Transaction } from "./api";
import { EmptyState, Skeleton, ErrorState, IconX } from "./states";
import { useTheme } from "./theme";
import { chartColors } from "./chart";
import { useNav } from "./nav";
import { TimeRangePicker, StreamStatus, resolveSel, selLabel, useTimeSel } from "./range";

// Relative "…전" so operators scan recency at a glance.
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
// Bucket size that keeps the trend chart around ~40 bars for any window.
function stepFor(fromISO: string, toISO: string): number {
  const min = (new Date(toISO).getTime() - new Date(fromISO).getTime()) / 60000;
  return Math.max(1, Math.min(1440, Math.round(min / 40)));
}
function typeTone(t: string): string {
  if (t.startsWith("HTTP 4")) return "warn";
  return "err"; // 5xx, HTTP 0 (connection failure), and named exceptions
}

function DetailModal({ group, win, onClose, onTrace }: {
  group: ErrorGroup;
  win: { fromISO: string; toISO: string };
  onClose: () => void;
  onTrace: (traceId: string) => void;
}) {
  const { theme } = useTheme();
  const c = chartColors(theme);
  const stepMin = stepFor(win.fromISO, win.toISO);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["error-detail", group.fingerprint, win.fromISO, win.toISO],
    queryFn: () => fetchErrorDetail(group, win.fromISO, win.toISO, stepMin),
  });
  const trend = data?.trend ?? [];
  const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  // Zero-fill a continuous bucket axis (the backend only returns non-empty
  // buckets) so a 2-occurrence issue reads as two small bars on a real timeline,
  // not a fake 50%-wide spike. Bucket boundaries match ClickHouse toStartOfInterval.
  const stepMs = stepMin * 60_000;
  const floorB = (ms: number) => Math.floor(ms / stepMs) * stepMs;
  const startB = floorB(new Date(win.fromISO).getTime());
  const endB = floorB(new Date(win.toISO).getTime());
  const axis: number[] = [];
  for (let b = startB; b <= endB && axis.length < 500; b += stepMs) axis.push(b);
  const countAt = new Map(trend.map((p) => [floorB(new Date(p.minute).getTime()), p.count]));
  const option = {
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", backgroundColor: c.tip, borderColor: c.tipBorder, textStyle: { color: c.tipText } },
    grid: { left: 40, right: 14, top: 12, bottom: 24 },
    xAxis: { type: "category", data: axis.map((b) => hm(new Date(b).toISOString())), axisLabel: { color: c.axis, hideOverlap: true }, axisLine: { lineStyle: { color: c.split } } },
    yAxis: { type: "value", axisLabel: { color: c.axis }, splitLine: { lineStyle: { color: c.split } }, minInterval: 1 },
    series: [{ type: "bar", data: axis.map((b) => countAt.get(b) ?? 0), color: "#f87171", barMaxWidth: 16, itemStyle: { borderRadius: [2, 2, 0, 0] } }],
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-lg" role="dialog" aria-modal="true" aria-label="에러 상세" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <span className="modal-svc">{group.service}</span>
            <span className="modal-txn">{group.operation} · {group.errorType}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기"><IconX /></button>
        </div>
        <div className="modal-body">
          {isError ? <ErrorState error={new Error("에러 상세를 불러오지 못했어요")} onRetry={() => refetch()} /> : <>
          {group.message && <p className="err-detail-msg">{group.message}</p>}
          <div className="err-detail-stats">
            <span><b>{(data?.total ?? group.count).toLocaleString()}</b>회 발생</span>
            <span>처음 <b>{ago(group.firstSeen)}</b></span>
            <span>마지막 <b>{ago(group.lastSeen)}</b></span>
          </div>
          <div className="section-label">발생 추이</div>
          {isLoading ? <Skeleton rows={4} /> : trend.length === 0 ? (
            <p className="err-empty-inline">이 구간에 발생 기록이 없어요.</p>
          ) : <div style={{ height: 160 }}><ReactECharts option={option} style={{ height: "100%" }} notMerge /></div>}
          <div className="section-label">최근 발생 <span className="hint-inline">클릭하면 트레이스</span></div>
          {isLoading ? <Skeleton rows={5} /> : (
            <table className="tbl">
              <thead><tr><th>시각</th><th className="r">상태</th><th>메시지</th><th>트레이스</th></tr></thead>
              <tbody>
                {(data?.samples ?? []).map((s, i) => (
                  <tr key={i} tabIndex={0} style={{ cursor: "pointer" }} onClick={() => onTrace(s.traceId)} onKeyDown={(e) => { if (e.key === "Enter") onTrace(s.traceId); }}>
                    <td>{s.time.slice(11, 19)}</td>
                    <td className="r"><span className={`chip ${s.status >= 500 || s.status === 0 ? "err" : s.status >= 400 ? "warn" : ""}`}><span className="dot" />{s.status || "ERR"}</span></td>
                    <td className="db-stmt" title={s.message}>{s.message || <span className="tx-dim">—</span>}</td>
                    <td className="mono err-trace-cell">{s.traceId.slice(0, 14)}… <span aria-hidden>→</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </>}
        </div>
      </div>
    </div>
  );
}

export function Errors() {
  const { openTrace } = useNav();
  const [sel, setSel] = useTimeSel();
  const minute = Math.floor(Date.now() / 60000);
  const win = resolveSel(sel, minute * 60000);
  const [active, setActive] = useState<ErrorGroup | null>(null);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["error-groups", win.fromISO, win.toISO],
    queryFn: () => fetchErrorGroups(win.fromISO, win.toISO),
    refetchInterval: win.live ? 10000 : false,
    placeholderData: keepPreviousData,
  });
  const groups = data ?? [];
  const total = groups.reduce((a, g) => a + g.count, 0);
  const openById = (traceId: string) =>
    openTrace({ traceId, serviceName: "", transactionName: "", statusCode: "", startTime: "", durationMs: 0 } as Transaction);

  return (
    <div className="content-scroll">
      <div className="err-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">에러 추적 <span className="hint-inline">{groups.length}개 이슈 · {total.toLocaleString()}건</span></span>
          <div style={{ marginLeft: "auto" }}><TimeRangePicker value={sel} onChange={setSel} /></div>
        </div>
        {isError && !data ? (
          <ErrorState error={new Error("에러 목록을 불러오지 못했어요")} onRetry={() => refetch()} />
        ) : isLoading && !data ? (
          <Skeleton rows={10} />
        ) : groups.length === 0 ? (
          <EmptyState title="에러가 없어요 🎉" body="이 기간에는 에러 스팬이 없어요. 서비스가 에러(status ERROR)를 보내면 서비스·작업·유형별로 묶여 여기에 쌓여요." hint={selLabel(sel)} />
        ) : (
          <>
            <StreamStatus sel={sel} everyLabel="10초마다 갱신" />
            <table className="tbl err-tbl">
              <thead>
                <tr><th>이슈</th><th>유형</th><th>메시지</th><th className="r">발생</th><th className="r">마지막</th></tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.fingerprint} tabIndex={0} style={{ cursor: "pointer" }} onClick={() => setActive(g)} onKeyDown={(e) => { if (e.key === "Enter") setActive(g); }}>
                    <td className="err-issue"><span className="err-svc">{g.service}</span><span className="err-op">{g.operation || "—"}</span></td>
                    <td><span className={`chip ${typeTone(g.errorType)}`}><span className="dot" />{g.errorType}</span></td>
                    <td className="db-stmt" title={g.message}>{g.message || <span className="tx-dim">—</span>}</td>
                    <td className="r err-count">{g.count.toLocaleString()}</td>
                    <td className="r err-last">{ago(g.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
      {active && <DetailModal group={active} win={win} onClose={() => setActive(null)} onTrace={(id) => { setActive(null); openById(id); }} />}
    </div>
  );
}
