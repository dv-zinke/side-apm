import type { LogLine } from "./api";

function sevClass(s: string): string {
  const u = s.toUpperCase();
  if (u.startsWith("ERR") || u === "FATAL") return "err";
  if (u.startsWith("WARN")) return "warn";
  if (u.startsWith("DEBUG") || u === "TRACE") return "muted";
  return "ok";
}

export function LogList({ logs, onTrace }: { logs: LogLine[]; onTrace?: (traceId: string) => void }) {
  return (
    <div className="loglist">
      {logs.map((l, i) => (
        <div
          key={i}
          className={`logrow${onTrace && l.traceId ? " clickable" : ""}`}
          onClick={onTrace && l.traceId ? () => onTrace(l.traceId) : undefined}
          title={onTrace && l.traceId ? "이 트레이스 열기" : undefined}
        >
          <span className="log-time">{l.time.slice(11, 23)}</span>
          <span className={`chip ${sevClass(l.severity)} log-sev`}><span className="dot" />{l.severity.toUpperCase()}</span>
          <span className="log-svc">{l.service}</span>
          <span className="log-body">{l.body}</span>
        </div>
      ))}
    </div>
  );
}
