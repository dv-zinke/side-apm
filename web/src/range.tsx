// Shared time selection for "조회" views (dashboard, RED, …). Handles both
// relative windows (live, auto-refresh) and absolute windows (fixed from–to),
// plus availability warnings driven by the server's retention horizons.
import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchRetention } from "./api";
import { Calendar } from "./Calendar";
import { getParam, replaceParams } from "./urlState";

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

// ── URL persistence ─────────────────────────────────────────
// The window lives in the address bar (?range=1h | ?from=…&to=…) so a reload
// keeps it and a copied link reproduces it. Shared across every view's picker.
const isoish = (s: string) => !Number.isNaN(Date.parse(s));
export function selToParams(sel: TimeSel): Record<string, string | null> {
  if (sel.kind === "relative") return { range: sel.id, from: null, to: null };
  return { range: null, from: sel.fromISO, to: sel.toISO };
}
export function selFromURL(): TimeSel {
  const from = getParam("from"), to = getParam("to");
  if (from && to && isoish(from) && isoish(to)) return { kind: "absolute", fromISO: from, toISO: to };
  const range = getParam("range");
  if (range && RANGES.some((r) => r.id === range)) return { kind: "relative", id: range as RangeId };
  return DEFAULT_SEL;
}
// Drop-in replacement for useState<TimeSel>: reads the URL at mount, writes it
// back (replaceState) on every change so it stays shareable without spamming
// browser history.
export function useTimeSel(): [TimeSel, (s: TimeSel) => void] {
  const [sel, setSel] = useState<TimeSel>(selFromURL);
  const set = (s: TimeSel) => { setSel(s); replaceParams(selToParams(s)); };
  return [sel, set];
}

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
// A local-input string is "YYYY-MM-DDTHH:mm" — split so the calendar owns the
// date part and the time inputs own the time part.
const datePart = (l: string) => l.slice(0, 10);
const timePart = (l: string) => l.slice(11, 16);
const ymd = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

// Human span between two local-input strings, e.g. "3시간 20분".
function fmtDuration(fromL: string, toL: string): string {
  let ms = new Date(toL).getTime() - new Date(fromL).getTime();
  if (!(ms > 0)) return "";
  const d = Math.floor(ms / 86400_000); ms -= d * 86400_000;
  const h = Math.floor(ms / 3600_000); ms -= h * 3600_000;
  const m = Math.floor(ms / 60_000);
  const parts = [];
  if (d) parts.push(`${d}일`);
  if (h) parts.push(`${h}시간`);
  if (m && !d) parts.push(`${m}분`);
  return parts.join(" ") || "1분 미만";
}

// One-tap shortcuts so the common windows need no typing at all.
const QUICK: { label: string; win: (now: Date) => [Date, Date] }[] = [
  { label: "최근 1시간", win: (n) => [new Date(n.getTime() - 3600_000), n] },
  { label: "최근 6시간", win: (n) => [new Date(n.getTime() - 6 * 3600_000), n] },
  { label: "최근 24시간", win: (n) => [new Date(n.getTime() - 24 * 3600_000), n] },
  { label: "오늘", win: (n) => [new Date(n.getFullYear(), n.getMonth(), n.getDate()), n] },
  { label: "어제", win: (n) => [new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1), new Date(n.getFullYear(), n.getMonth(), n.getDate())] },
  { label: "지난 7일", win: (n) => [new Date(n.getTime() - 7 * 86400_000), n] },
];

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
  const [activeQuick, setActiveQuick] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "done" | "fail">("idle");
  const editFrom = (v: string) => { setFromL(v); setActiveQuick(null); };
  const editTo = (v: string) => { setToL(v); setActiveQuick(null); };
  const pickQuick = (label: string, f: Date, t: Date) => {
    setFromL(toLocalInput(f.toISOString()));
    setToL(toLocalInput(t.toISOString()));
    setActiveQuick(label);
  };
  const openCustom = () => {
    const s = resolveSel(value, Date.now());
    setFromL(toLocalInput(s.fromISO));
    setToL(toLocalInput(s.toISO));
    setActiveQuick(null);
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

      <button
        className={`range-share${copy === "fail" ? " fail" : ""}`}
        aria-label="이 화면(기간·뷰) 링크 복사"
        title="이 화면(기간·뷰) 링크 복사"
        onClick={async () => {
          try { await navigator.clipboard.writeText(window.location.href); setCopy("done"); setTimeout(() => setCopy("idle"), 1500); }
          catch { setCopy("fail"); setTimeout(() => setCopy("idle"), 3000); }
        }}
      >
        {copy === "done" ? "복사됨 ✓" : copy === "fail" ? "주소창에서 복사" : <><span aria-hidden>🔗</span> 공유</>}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copy === "done" ? "링크를 복사했어요" : copy === "fail" ? "복사하지 못했어요. 주소창의 주소를 복사해주세요." : ""}
      </span>

      {open && (
        <div className="range-custom" role="dialog" aria-modal="true" aria-label="사용자 지정 기간" ref={dialogRef} onKeyDown={trap}>
          <div className="range-quick" role="group" aria-label="빠른 선택">
            {QUICK.map((q) => (
              <button
                key={q.label}
                type="button"
                className="range-quick-chip"
                data-active={activeQuick === q.label || undefined}
                aria-current={activeQuick === q.label || undefined}
                onClick={() => { const [f, t] = q.win(new Date()); pickQuick(q.label, f, t); }}
              >
                {q.label}
              </button>
            ))}
          </div>
          <Calendar
            start={new Date(fromL)}
            end={new Date(toL)}
            max={new Date()}
            onChange={(s, e) => { setFromL(`${ymd(s)}T${timePart(fromL)}`); setToL(`${ymd(e)}T${timePart(toL)}`); setActiveQuick(null); }}
          />
          <div className="cal-times">
            <label className="range-field"><span className="field-label">시작 시각</span>
              <input className="input" type="time" value={timePart(fromL)} onChange={(e) => editFrom(`${datePart(fromL)}T${e.target.value}`)} />
            </label>
            <label className="range-field"><span className="field-label">종료 시각</span>
              <div className="range-end">
                <input className="input" type="time" value={timePart(toL)} onChange={(e) => editTo(`${datePart(toL)}T${e.target.value}`)} />
                <button type="button" className="btn range-now" onClick={() => editTo(toLocalInput(new Date().toISOString()))}>지금</button>
              </div>
            </label>
          </div>
          {invalid ? (
            <span className="range-warn" role="alert">시작이 종료보다 빨라야 해요</span>
          ) : (
            <span className="range-span" role="status">선택 구간 · {fmtDuration(fromL, toL)}</span>
          )}
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

// Honest freshness banner for streaming views: is the data live-tailing, or is
// this a frozen historical window? Reused by Logs (and any stream view).
export function StreamStatus({ sel, everyLabel = "자동 갱신" }: { sel: TimeSel; everyLabel?: string }) {
  const live = sel.kind === "relative";
  return (
    <div className={`stream-status${live ? " live" : ""}`} role="status" aria-live="polite">
      {live ? (
        <><span className="live-dot" /> 실시간 · {everyLabel} · 최근 {rangeById(sel.id).label}</>
      ) : (
        <><span aria-hidden>📌</span> 고정 조회 · {selLabel(sel)} · 갱신 멈춤</>
      )}
    </div>
  );
}
