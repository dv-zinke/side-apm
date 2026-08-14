import { useState, useRef, useEffect } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { TransactionTable } from "./TransactionTable";
import { TraceTree } from "./TraceTree";
import { RecordSummary } from "./RecordSummary";
import { RedDashboard } from "./RedDashboard";
import { ServiceMap } from "./ServiceMap";
import { XView } from "./XView";
import { Dashboard } from "./Dashboard";
import { Runtime } from "./Runtime";
import { Onboarding } from "./Onboarding";
import { TraceModal } from "./TraceModal";
import { ThemeProvider, useTheme } from "./theme";
import { LiveProvider } from "./live";
import { NavCtx } from "./nav";
import {
  EmptyState, IconTrace,
  IconGrid, IconTraceNav, IconPulse, IconGraphNav, IconScatter, IconGauge, IconPlug, IconSun, IconMoon,
} from "./states";
import type { Transaction } from "./api";
import "./App.css";

const qc = new QueryClient();

type View = "dashboard" | "connect" | "trace" | "red" | "runtime" | "map" | "xview";
type NavItem = { id: View; label: string; icon: () => React.ReactElement };
const GROUPS: { label: string; items: NavItem[] }[] = [
  { label: "개요", items: [
    { id: "dashboard", label: "대시보드", icon: IconGrid },
    { id: "connect", label: "연결하기", icon: IconPlug },
  ] },
  { label: "모니터링", items: [
    { id: "trace", label: "트레이스 분석", icon: IconTraceNav },
    { id: "red", label: "RED 대시보드", icon: IconPulse },
    { id: "runtime", label: "런타임", icon: IconGauge },
  ] },
  { label: "토폴로지 · 실시간", items: [
    { id: "map", label: "서비스맵", icon: IconGraphNav },
    { id: "xview", label: "X-View", icon: IconScatter },
  ] },
];
const ALL = GROUPS.flatMap((g) => g.items);
const titleOf = (v: View) => ALL.find((i) => i.id === v)!.label;

function Sidebar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  function onKey(e: React.KeyboardEvent, idx: number) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = e.key === "ArrowDown" ? (idx + 1) % ALL.length : (idx - 1 + ALL.length) % ALL.length;
    setView(ALL[next].id);
    refs.current[ALL[next].id]?.focus();
  }
  return (
    <aside className="sidebar">
      <div className="workspace">
        <svg className="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12h4l2 6 4-14 2 8h6" />
        </svg>
        <span className="workspace-name">APM Console</span>
      </div>
      <nav className="nav" role="tablist" aria-orientation="vertical" aria-label="관제 화면">
        {GROUPS.map((g) => (
          <div className="nav-group" key={g.label}>
            <div className="nav-label">{g.label}</div>
            {g.items.map((it) => {
              const active = view === it.id;
              const idx = ALL.findIndex((x) => x.id === it.id);
              return (
                <button
                  key={it.id}
                  ref={(el) => { refs.current[it.id] = el; }}
                  role="tab"
                  id={`tab-${it.id}`}
                  aria-selected={active}
                  aria-controls="panel"
                  tabIndex={active ? 0 : -1}
                  className={`nav-item${active ? " active" : ""}`}
                  onClick={() => setView(it.id)}
                  onKeyDown={(e) => onKey(e, idx)}
                >
                  <span className="nav-ico">{it.icon()}</span>
                  <span className="nav-text">{it.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

// Ticking freshness — reflects how recently any polling query last succeeded,
// so the console visibly "breathes" instead of updating silently.
function Freshness() {
  const qc = useQueryClient();
  const last = useRef(Date.now());
  const [ago, setAgo] = useState(0);
  useEffect(() => {
    const unsub = qc.getQueryCache().subscribe((e: any) => {
      if (e?.type === "updated" && e.query?.state?.status === "success" && e.action?.type === "success") {
        last.current = Date.now();
        setAgo(0);
      }
    });
    const iv = setInterval(() => setAgo(Math.floor((Date.now() - last.current) / 1000)), 1000);
    return () => { unsub(); clearInterval(iv); };
  }, [qc]);
  return <span className="fresh" aria-live="off">{ago <= 1 ? "방금 갱신" : `${ago}초 전 갱신`}</span>;
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      className="icon-btn"
      onClick={toggle}
      aria-label={theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"}
      title={theme === "dark" ? "라이트 모드" : "다크 모드"}
    >
      {theme === "dark" ? <IconSun /> : <IconMoon />}
    </button>
  );
}

function Console() {
  const [sel, setSel] = useState<Transaction | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [modalTrace, setModalTrace] = useState<Transaction | null>(null);
  const [svcFilter, setSvcFilter] = useState("");
  // Drill-down from a live widget → open the trace in an overlay, so the
  // dashboard and its live streams keep running underneath.
  const openTrace = (t: Transaction) => setModalTrace(t);
  // Service map node → jump to the transaction list filtered to that service.
  const openService = (name: string) => { setSvcFilter(name); setSel(null); setView("trace"); };
  return (
    <NavCtx.Provider value={{ openTrace, openService }}>
    <div className="shell">
      <Sidebar view={view} setView={setView} />
      <div className="main">
        <header className="topbar">
          <h1 className="page-title">{titleOf(view)}</h1>
          <Freshness />
          <span className="live" aria-label="실시간 수신 중">
            <span className="live-dot" /><span className="live-text">live</span>
          </span>
          <ThemeToggle />
        </header>
        <main className="content" id="panel" role="tabpanel" aria-labelledby={`tab-${view}`}>
          {view === "dashboard" ? (
            <div className="content-scroll"><Dashboard /></div>
          ) : view === "connect" ? (
            <Onboarding />
          ) : view === "runtime" ? (
            <Runtime />
          ) : view === "map" ? (
            <ServiceMap />
          ) : view === "xview" ? (
            <XView />
          ) : view === "red" ? (
            <RedDashboard />
          ) : (
            <div className="split">
              <section className="pane pane-list" aria-label="트랜잭션 목록">
                <TransactionTable selected={sel} onSelect={setSel} service={svcFilter} onService={setSvcFilter} />
              </section>
              <section className="pane pane-detail" aria-label="트랜잭션 상세">
                {sel ? (
                  <div className="pane-body">
                    <div className="section-label">레코드 요약</div>
                    <RecordSummary traceId={sel.traceId} />
                    <div className="section-label">트리 뷰 · 워터폴</div>
                    <TraceTree traceId={sel.traceId} />
                  </div>
                ) : (
                  <EmptyState
                    icon={<IconTrace />}
                    title="트랜잭션을 선택해주세요"
                    body="왼쪽 목록에서 트랜잭션을 고르면 요약과 스팬 워터폴이 여기에 펼쳐져요."
                    hint="5초마다 자동 갱신"
                  />
                )}
              </section>
            </div>
          )}
        </main>
      </div>
      {modalTrace && <TraceModal txn={modalTrace} onClose={() => setModalTrace(null)} />}
    </div>
    </NavCtx.Provider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <LiveProvider>
          <Console />
        </LiveProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
