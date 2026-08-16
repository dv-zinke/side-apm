/* Shared 12-state building blocks — loading / empty / error.
   Copy follows 01-ux-excellence §6: controls name the action,
   errors name the problem and the recovery. No forbidden phrases. */

export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="sk" role="status" aria-label="불러오는 중">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="sk-row" />)}
    </div>
  );
}

export function EmptyState({
  icon, title, body, hint,
}: { icon?: React.ReactNode; title: string; body: string; hint?: string }) {
  return (
    <div className="state">
      {icon ?? <IconInbox />}
      <h4>{title}</h4>
      <p>{body}</p>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="state err" role="alert">
      <IconAlert />
      <h4>데이터를 불러오지 못했어요</h4>
      <p>쿼리 서비스(:8080)에 닿지 못했어요. 스택이 떠 있는지 확인하고 다시 시도해주세요.</p>
      <span className="hint">{msg}</span>
      {onRetry && <button className="btn" onClick={onRetry}>다시 시도</button>}
    </div>
  );
}

/* ── Authored icons — one stroke system, no emoji ──────────── */
const S = { width: 40, height: 40, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function IconInbox() {
  return (
    <svg {...S}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
  );
}
export function IconAlert() {
  return (
    <svg {...S}><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /></svg>
  );
}
export function IconTrace() {
  return (
    <svg {...S}><circle cx="5" cy="6" r="2" /><circle cx="5" cy="18" r="2" /><path d="M5 8v8" /><path d="M7 6h6a4 4 0 0 1 0 8H9" /><path d="M11 18h6" /></svg>
  );
}
export function IconGraph() {
  return (
    <svg {...S}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8 7.5 16 16.5" /><path d="M8.2 6H15.8" /></svg>
  );
}

/* Nav + control icons — 18px, same stroke system */
const N = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
export const IconTraceNav   = () => <svg {...N}><circle cx="5" cy="6" r="2" /><circle cx="5" cy="18" r="2" /><path d="M5 8v8" /><path d="M7 6h6a4 4 0 0 1 0 8H9" /><path d="M11 18h6" /></svg>;
export const IconPulse      = () => <svg {...N}><path d="M3 12h4l2 6 4-14 2 8h6" /></svg>;
export const IconGraphNav   = () => <svg {...N}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8 7.5 16 16.5" /><path d="M8.2 6H15.8" /></svg>;
export const IconScatter    = () => <svg {...N}><path d="M3 3v18h18" /><circle cx="8" cy="15" r="1.4" /><circle cx="12" cy="9" r="1.4" /><circle cx="16" cy="12" r="1.4" /><circle cx="18" cy="6" r="1.4" /></svg>;
export const IconSun        = () => <svg {...N}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
export const IconMoon       = () => <svg {...N}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>;
export const IconGrid       = () => <svg {...N}><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg>;
export const IconX          = () => <svg {...N}><path d="M18 6 6 18M6 6l12 12" /></svg>;
export const IconGauge      = () => <svg {...N}><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" /><path d="m13.4 12.6 3.6-3.6" /><path d="M4.2 18a9 9 0 1 1 15.6 0" /></svg>;
export const IconPlug       = () => <svg {...N}><path d="M12 22v-5" /><path d="M9 8V2M15 8V2" /><path d="M18 8H6v3a6 6 0 0 0 12 0V8z" /></svg>;
export const IconLogs       = () => <svg {...N}><path d="M8 6h11M8 12h11M8 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></svg>;
export const IconBell       = () => <svg {...N}><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9z" /></svg>;
export const IconDB         = () => <svg {...N}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6a8 3 0 0 0 16 0V5" /><path d="M4 11v6a8 3 0 0 0 16 0v-6" /></svg>;
export const IconRum        = () => <svg {...N}><circle cx="12" cy="12" r="9" /><path d="M3.6 9h16.8M3.6 15h16.8" /><path d="M12 3a14 14 0 0 0 0 18 14 14 0 0 0 0-18z" /></svg>;
export const IconContainer  = () => <svg {...N}><path d="M3 8l9-4 9 4v8l-9 4-9-4z" /><path d="M3 8l9 4 9-4M12 12v8" /></svg>;
export const IconHeartbeat  = () => <svg {...N}><path d="M22 12h-4l-3 8-4-16-3 8H2" /></svg>;
export const IconAnomaly    = () => <svg {...N}><path d="M3 15l4-6 4 4 3-7 3 5" /><path d="M18 3v4M18 10v.01" /></svg>;
