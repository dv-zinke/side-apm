import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchProfiles, fetchProfile } from "./api";
import type { ProfileMeta, FlameNode } from "./api";
import { EmptyState, Skeleton } from "./states";

// Warm flame palette keyed by a stable hash of the function name.
function color(name: string, depth: number) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  const hue = 18 + (h % 34); // 18–52° = red→orange→yellow
  const light = 42 + (depth % 4) * 6;
  return `hsl(${hue} 82% ${light}%)`;
}

function shortName(n: string) {
  const s = n.replace(/^github\.com\//, "").replace(/^golang\.org\//, "");
  return s.length > 48 ? "…" + s.slice(-46) : s;
}

function Flame({ node, depth, total }: { node: FlameNode; depth: number; total: number }) {
  const kids = (node.children ?? []).filter((c) => c.value / total > 0.002).sort((a, b) => b.value - a.value);
  return (
    <div className="flame-node">
      {depth > 0 && (
        <div className="flame-bar" style={{ background: color(node.name, depth) }} title={`${node.name} · ${((node.value / total) * 100).toFixed(1)}%`}>
          <span className="flame-label">{shortName(node.name)}</span>
        </div>
      )}
      {kids.length > 0 && (
        <div className="flame-children">
          {kids.map((c, i) => (
            <div key={i} style={{ flexBasis: `${(c.value / node.value) * 100}%`, flexGrow: 0, flexShrink: 0, minWidth: 0 }}>
              <Flame node={c} depth={depth + 1} total={total} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmt(v: number, unit: string, total: number) {
  const pct = total > 0 ? ((v / total) * 100).toFixed(1) + "%" : "";
  if (unit === "nanoseconds") return `${(v / 1e6).toFixed(1)}ms · ${pct}`;
  if (unit === "bytes") return `${(v / 1e6).toFixed(1)}MB · ${pct}`;
  return `${v.toLocaleString()} · ${pct}`;
}

function ProfileDetailView({ id }: { id: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["profile", id], queryFn: () => fetchProfile(id) });
  if (isLoading) return <Skeleton rows={10} />;
  if (!data) return null;
  const total = data.tree.value || 1;
  return (
    <>
      <div className="section-label">플레임그래프 <span className="hint-inline">위→아래 콜스택, 너비 ∝ {data.type === "cpu" ? "CPU 시간" : "메모리"}</span></div>
      <div className="flame-root">
        <Flame node={data.tree} depth={0} total={total} />
      </div>
      <div className="section-label" style={{ marginTop: "var(--sp-4)" }}>상위 함수 (self)</div>
      <table className="tbl">
        <thead><tr><th>함수</th><th className="r">self</th><th className="r">cumulative</th></tr></thead>
        <tbody>
          {data.top.map((f, i) => (
            <tr key={i} style={{ cursor: "default" }}>
              <td className="db-stmt" title={f.name}>{shortName(f.name)}</td>
              <td className="r">{fmt(f.flat, data.unit, total)}</td>
              <td className="r">{fmt(f.cum, data.unit, total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function Profiling() {
  const { data: profiles, isLoading } = useQuery({ queryKey: ["profiles"], queryFn: () => fetchProfiles(40), refetchInterval: 30000 });
  const [sel, setSel] = useState<string | null>(null);
  const list = profiles ?? [];
  const active = sel ?? list[0]?.id ?? null;

  return (
    <div className="content-scroll">
      <div className="prof-view">
        <div className="pane-head" style={{ position: "static", borderTop: 0 }}>
          <span className="pane-title">연속 프로파일링 <span className="hint-inline">Go 서비스 pprof를 주기 수집</span></span>
        </div>
        {isLoading ? (
          <Skeleton rows={6} />
        ) : list.length === 0 ? (
          <EmptyState title="아직 프로파일이 없어요" body="프로파일러가 Go 서비스(gateway·query)의 CPU·힙 pprof를 주기적으로 수집하면 여기에 플레임그래프가 나타나요." />
        ) : (
          <div className="prof-layout">
            <aside className="prof-list">
              {list.map((p: ProfileMeta) => (
                <button key={p.id} className={`prof-item ${active === p.id ? "active" : ""}`} onClick={() => setSel(p.id)}>
                  <span className="prof-item-top"><span className={`chip ${p.type === "cpu" ? "warn" : "ok"}`} style={{ padding: "0 6px" }}>{p.type.toUpperCase()}</span> {p.target}</span>
                  <span className="prof-item-time">{p.time.slice(11, 19)}</span>
                </button>
              ))}
            </aside>
            <div className="prof-detail">{active && <ProfileDetailView id={active} />}</div>
          </div>
        )}
      </div>
    </div>
  );
}
