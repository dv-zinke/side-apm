// Shared time selection for "조회" views (dashboard, RED, …). Handles both
// relative windows (live, auto-refresh) and absolute windows (fixed from–to),
// plus availability warnings driven by the server's retention horizons.
import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchRetention } from "./api";

export type RangeId = "15m" | "1h" | "6h" | "24h" | "7d" | "30d";
export type Range = { id: RangeId; label: string; minutes: number };

export const RANGES: Range[] = [
  { id: "15m", label: "15분", minutes: 15 },
  { id: "1h", label: "1시간", minutes: 60 },
  { id: "6h", label: "6시간", minutes: 360 },
  { id: "24h", label: "24시간", minutes: 1440 },
  { id: "7d", label: "7일", minutes: 10080 },
  { id: "30d", label: "30일", minutes: 43200 },
];

export const rangeById = (id: RangeId): Range => RANGES.find((r) => r.id === id) ?? RANGES[1];

// A selection is either a live relative window or a fixed absolute one.
export type TimeSel = { kind: "relative"; id: RangeId } | { kind: "absolute"; fromISO: string; toISO: string };
export const DEFAULT_SEL: TimeSel = { kind: "relative", id: "1h" };

// Resolve to a concrete window. `live` tells the caller whether to auto-refresh.
export function resolveSel(sel: TimeSel, nowMs: number): { fromISO: string; toISO: string; live: boolean } {
  if (sel.kind === "absolute") return { fromISO: sel.fromISO, toISO: sel.toISO, live: false };
  const r = rangeById(sel.id);
  return { fromISO: new Date(nowMs - r.minutes * 60_000).toISOString(), toISO: new Date(nowMs).toISOString(), live: true };
}

const two = (n: number) => String(n).padStart(2, "0");
const fmtShort = (iso: string) => {
  const d = new Date(iso);
  return `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
export function selLabel(sel: TimeSel): string {
  if (sel.kind === "relative") return `최근 ${rangeById(sel.id).label}`;
  return `${fmtShort(sel.fromISO)} – ${fmtShort(sel.toISO)}`;
}

// <input type="datetime-local"> <-> ISO. datetime-local is local wall-clock.
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};
const fromLocalInput = (s: string) => new Date(s).toISOString();

export function TimeRangePicker({ value, onChange }: { value: TimeSel; onChange: (s: TimeSel) => void }) {
  const [open, setOpen] = useState(false);
  const { data: ret } = useQuery({ queryKey: ["retention"], queryFn: fetchRetention, staleTime: Infinity });
  const isAbs = value.kind === "absolute";
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Seed the custom inputs from the currently-resolved window.
  const seed = resolveSel(value, Date.now());
  const [fromL, setFromL] = useState(toLocalInput(seed.fromISO));
  const [toL, setToL] = useState(toLocalInput(seed.toISO));
  const openCustom = () => {
    const s = resolveSel(value, Date.now());
    setFromL(toLocalInput(s.fromISO));
    setToL(toLocalInput(s.toISO));
    setOpen(true);
  };
  const invalid = new Date(fromL).getTime() >= new Date(toL).getTime();
  const apply = () => {
    if (invalid) return;
    onChange({ kind: "absolute", fromISO: fromLocalInput(fromL), toISO: fromLocalInput(toL) });
    setOpen(false);
  };

  // Dialog contract: focus the first field on open, Esc + outside-click close.
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.querySelector<HTMLElement>("input")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open]);

  // Minimal focus trap so Tab cycles within the open dialog.
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const foc = dialogRef.current?.querySelectorAll<HTMLElement>("input, button:not([disabled])");
    if (!foc || !foc.length) return;
    const first = foc[0], last = foc[foc.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  // Availability warning reacts to what's being EDITED (fromL), so it shows
  // before the user commits an out-of-retention window — not after.
  const editFromMs = new Date(fromL).getTime();
  const beyondTrace = !!ret && !invalid && editFromMs < Date.now() - ret.traceDays * 86400_000;

  return (
    <div className="range-picker" ref={rootRef}>
      <div className="segmented" role="radiogroup" aria-label="조회 기간">
        {RANGES.map((r) => {
          const on = value.kind === "relative" && value.id === r.id;
          return (
            <button key={r.id} role="radio" aria-checked={on} className="seg" onClick={() => onChange({ kind: "relative", id: r.id })}>
              {r.label}
            </button>
          );
        })}
        <button
          role="radio"
          aria-checked={isAbs}
          aria-label={isAbs ? `고정 기간 ${selLabel(value)}` : "사용자 지정 기간"}
          className={`seg${isAbs ? "" : " seg-ghost"}`}
          onClick={openCustom}
        >
          {isAbs ? <><span aria-hidden>📌</span> {selLabel(value)}</> : "사용자 지정"}
        </button>
      </div>

      {isAbs && (
        <button className="range-live-btn" onClick={() => onChange(DEFAULT_SEL)} aria-label="실시간 자동 갱신으로 돌아가기">
          <span className="live-dot" /> 실시간
        </button>
      )}

      {open && (
        <div className="range-custom" role="dialog" aria-modal="true" aria-label="사용자 지정 기간" ref={dialogRef} onKeyDown={trap}>
          <label className="range-field"><span className="field-label">시작</span>
            <input className="input" type="datetime-local" value={fromL} max={toL} onChange={(e) => setFromL(e.target.value)} />
          </label>
          <label className="range-field"><span className="field-label">종료</span>
            <input className="input" type="datetime-local" value={toL} min={fromL} onChange={(e) => setToL(e.target.value)} />
          </label>
          {invalid && <span className="range-warn" role="alert">시작이 종료보다 빨라야 해요</span>}
          {beyondTrace && ret && (
            <span className="range-note" role="status">이 구간은 집계 지표만 조회돼요 · 개별 트레이스는 {ret.traceDays}일 보관을 넘겼어요</span>
          )}
          <div className="range-actions">
            <button className="btn" onClick={() => setOpen(false)}>취소</button>
            <button className="btn btn-primary" onClick={apply} disabled={invalid}>적용</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Small caption showing the resolution the server actually served (data honesty).
export function ResolutionNote({ resolution }: { resolution?: string }) {
  if (!resolution) return null;
  const label: Record<string, string> = { "1m": "분 단위", "5m": "5분 간격", "15m": "15분 간격", "1h": "시간 단위", "6h": "6시간 간격", "1d": "일 단위" };
  return <span className="hint-inline" role="status" aria-live="polite">{label[resolution] ?? resolution} 집계</span>;
}
