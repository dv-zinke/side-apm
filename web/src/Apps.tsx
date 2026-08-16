import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAppOverview, fetchAppVersions, fetchAppGroup, fetchCrashDetail } from "./api";
import type { AppGroup } from "./api";
import { EmptyState, Skeleton, IconX } from "./states";

function CrashModal({ message, onClose }: { message: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ["crash", message], queryFn: () => fetchCrashDetail(message) });
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title"><span className="modal-svc">크래시 · {data ? `${data.sessions}세션 · ${data.count}회` : ""}</span><span className="modal-txn" style={{ fontFamily: "var(--sans)", color: "var(--err)" }}>{message}</span></div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기"><IconX /></button>
        </header>
        <div className="modal-body">
          {isLoading ? <Skeleton rows={6} /> : !data ? null : (
            <>
              <div className="crash-breakdown">
                <div><span className="crash-bk-label">앱 버전</span><div className="crash-chips">{data.versions.map((v) => <span key={v} className="chip muted">{v}</span>)}</div></div>
                <div><span className="crash-bk-label">디바이스</span><div className="crash-chips">{data.devices.map((v) => <span key={v} className="chip muted">{v}</span>)}</div></div>
                <div><span className="crash-bk-label">OS</span><div className="crash-chips">{data.oses.map((v) => <span key={v} className="chip muted">{v}</span>)}</div></div>
              </div>
              <div className="section-label" style={{ marginTop: "var(--sp-4)" }}>스택 트레이스</div>
              <pre className="crash-stack">{data.stack || "(스택 정보 없음)"}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value${tone ? " " + tone : ""}`}>{value}{unit && <span className="kpi-unit">{unit}</span>}</div>
    </div>
  );
}
const crashTone = (r: number) => (r >= 99.5 ? "ok" : r >= 99 ? "warn" : "err");
const startTone = (ms: number) => (ms > 2500 ? "err" : ms > 1500 ? "warn" : "ok");

function GroupCard({ title, kind, valueLabel, onPick }: { title: string; kind: "screens" | "crashes" | "network"; valueLabel: string; onPick?: (key: string) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ["app", kind], queryFn: () => fetchAppGroup(kind, 20), refetchInterval: 10000 });
  return (
    <section className="dash-panel">
      <div className="section-label">{title}</div>
      {isLoading ? <Skeleton rows={6} /> : (data ?? []).length === 0 ? (
        <div className="log-empty">아직 {title} 데이터가 없어요.</div>
      ) : (
        <table className="tbl">
          <thead><tr>
            <th>{kind === "crashes" ? "크래시" : kind === "network" ? "요청" : "화면"}</th>
            <th className="r">{valueLabel}</th>
            {kind === "crashes" && <th className="r">영향 세션</th>}
            {kind === "network" && <th className="r">평균</th>}
          </tr></thead>
          <tbody>
            {(data ?? []).map((g: AppGroup, i) => (
              <tr key={i} style={{ cursor: onPick ? "pointer" : "default" }} tabIndex={onPick ? 0 : undefined}
                  onClick={onPick ? () => onPick(g.key) : undefined}
                  onKeyDown={onPick ? (e) => { if (e.key === "Enter") onPick(g.key); } : undefined}>
                <td className={kind === "screens" ? "svc" : "db-stmt"} title={g.key}>{g.key}</td>
                <td className="r">{g.count.toLocaleString()}</td>
                {kind === "crashes" && <td className="r err">{g.sub}</td>}
                {kind === "network" && <td className="r">{g.avgMs.toFixed(0)} ms</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Apps() {
  const { data: ov, isLoading } = useQuery({ queryKey: ["app-overview"], queryFn: fetchAppOverview, refetchInterval: 10000 });
  const { data: versions } = useQuery({ queryKey: ["app-versions"], queryFn: fetchAppVersions, refetchInterval: 10000 });
  const [crash, setCrash] = useState<string | null>(null);
  const empty = ov && ov.sessions === 0;

  return (
    <div className="content-scroll">
      {crash && <CrashModal message={crash} onClose={() => setCrash(null)} />}
      <div className="dash">
        {isLoading ? (
          <div className="span-all"><Skeleton rows={4} /></div>
        ) : empty ? (
          <div className="span-all">
            <EmptyState
              title="아직 앱 데이터가 없어요"
              body="iOS/Android SDK가 /v1/app으로 세션·화면·크래시·네트워크를 보내면 여기에 모여요."
              hint='POST …4318/v1/app'
            />
          </div>
        ) : (
          <>
            <section className="kpi-grid span-all">
              <Kpi label="세션" value={(ov?.sessions ?? 0).toLocaleString()} />
              <Kpi label="크래시 프리" value={ov ? ov.crashFreeRate.toFixed(2) : "—"} unit="%" tone={ov ? crashTone(ov.crashFreeRate) : undefined} />
              <Kpi label="콜드 시작 p75" value={ov ? Math.round(ov.coldStartP75).toLocaleString() : "—"} unit="ms" tone={ov ? startTone(ov.coldStartP75) : undefined} />
              <Kpi label="웜 시작 p75" value={ov ? Math.round(ov.warmStartP75).toLocaleString() : "—"} unit="ms" />
              <Kpi label="네트워크 에러" value={ov ? ov.networkErrRate.toFixed(1) : "—"} unit="%" tone={ov && ov.networkErrRate > 5 ? "warn" : "ok"} />
            </section>

            <section className="dash-panel">
              <div className="section-label">활성 버전 · 플랫폼</div>
              <table className="tbl">
                <thead><tr><th>버전</th><th>플랫폼</th><th className="r">세션</th><th className="r">크래시 프리</th></tr></thead>
                <tbody>
                  {(versions ?? []).map((v, i) => (
                    <tr key={i} style={{ cursor: "default" }}>
                      <td className="svc">{v.version}</td>
                      <td><span className={`chip ${v.platform === "ios" ? "ok" : "muted"}`}><span className="dot" />{v.platform === "ios" ? "iOS" : "Android"}</span></td>
                      <td className="r">{v.sessions.toLocaleString()}</td>
                      <td className={`r ${crashTone(v.crashFreeRate)}`}>{v.crashFreeRate.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <GroupCard title="많이 본 화면" kind="screens" valueLabel="조회" />
            <GroupCard title="크래시 · 클릭하면 상세" kind="crashes" valueLabel="발생" onPick={setCrash} />
            <section className="span-all"><GroupCard title="네트워크 요청" kind="network" valueLabel="호출" /></section>
          </>
        )}
      </div>
    </div>
  );
}
