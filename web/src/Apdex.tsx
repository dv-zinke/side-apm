import { useQuery } from "@tanstack/react-query";
import { fetchApdex } from "./api";

function rating(score: number) {
  if (score >= 0.94) return { label: "Excellent", tone: "ok" as const };
  if (score >= 0.85) return { label: "Good", tone: "ok" as const };
  if (score >= 0.7) return { label: "Fair", tone: "warn" as const };
  if (score >= 0.5) return { label: "Poor", tone: "warn" as const };
  return { label: "Unacceptable", tone: "err" as const };
}

// Server-side Apdex from real latency histograms (http.server.duration), not a
// live-stream approximation — the value the alerting/SLO layer can trust.
export function ApdexCard({ service }: { service?: string }) {
  const minute = Math.floor(Date.now() / 60000);
  const { data } = useQuery({
    queryKey: ["apdex", service, minute],
    queryFn: () => fetchApdex(service!, 10),
    enabled: !!service,
    refetchInterval: 10000,
  });

  const has = data?.hasData;
  const r = has ? rating(data!.score) : null;
  return (
    <div className="kpi-card">
      <div className="kpi-label">Apdex · T={data?.tMs ?? 500}ms{service ? ` · ${service}` : ""}</div>
      <div className={`kpi-value${r ? " " + r.tone : ""}`}>{has ? data!.score.toFixed(2) : "—"}</div>
      {r
        ? <span className={`chip ${r.tone}`} style={{ alignSelf: "flex-start" }}><span className="dot" />{r.label}</span>
        : <span className="kpi-sub">히스토그램 대기 중</span>}
    </div>
  );
}
