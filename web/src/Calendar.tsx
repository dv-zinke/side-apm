import { useState, useEffect, useRef } from "react";

// A custom month calendar with range selection — replaces the browser's native
// datetime-local calendar so it matches the product's design. Date-only; time is
// chosen by separate inputs in the picker. Full keyboard grid (arrows/Home/End).
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const dayNum = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function Calendar({ start, end, max, onChange }: {
  start: Date | null;
  end: Date | null;
  max?: Date;
  onChange: (start: Date, end: Date) => void;
}) {
  const init = start ?? new Date();
  const [view, setView] = useState({ y: init.getFullYear(), m: init.getMonth() });
  // Local selection so the two-click (start → end) flow can hold an incomplete
  // range; resynced when the parent's committed range changes (e.g. quick chip).
  const [sel, setSel] = useState<{ s: Date | null; e: Date | null }>({ s: start, e: end });
  const [hover, setHover] = useState<Date | null>(null);
  const [focusIdx, setFocusIdx] = useState<number>(-1);
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setSel({ s: start, e: end }); }, [start?.getTime(), end?.getTime()]);

  const offset = new Date(view.y, view.m, 1).getDay();
  const cells = Array.from({ length: 42 }, (_, i) => new Date(view.y, view.m, 1 - offset + i));
  const today = dayNum(new Date());
  const maxN = max ? dayNum(max) : Infinity;
  const sN = sel.s ? dayNum(sel.s) : null;
  const eN = sel.e ? dayNum(sel.e) : null;
  const picking = sN != null && eN == null;
  // While picking the end, preview the range up to the hovered day.
  const hoverN = hover ? dayNum(hover) : null;
  const rangeEnd = eN ?? (picking && hoverN != null && hoverN >= (sN ?? 0) ? hoverN : null);

  const click = (d: Date) => {
    if (dayNum(d) > maxN) return;
    if (!sel.s || sel.e || dayNum(d) < dayNum(sel.s)) {
      setSel({ s: d, e: null }); // begin (or restart earlier)
    } else {
      setSel({ s: sel.s, e: d });
      onChange(sel.s, d); // range complete — commit (single day = same day twice)
      setHover(null);
    }
  };
  const shift = (n: number) => { setFocusIdx(-1); setView((v) => { const m = v.m + n; return { y: v.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 }; }); };

  const moveFocus = (from: number, delta: number) => {
    const n = Math.max(0, Math.min(41, from + delta));
    setFocusIdx(n);
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-idx="${n}"]`)?.focus());
  };
  const onGridKey = (e: React.KeyboardEvent) => {
    const cur = focusIdx < 0 ? 0 : focusIdx;
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) { e.preventDefault(); moveFocus(cur, step[e.key]); }
    else if (e.key === "Home") { e.preventDefault(); moveFocus(cur, -(cur % 7)); }
    else if (e.key === "End") { e.preventDefault(); moveFocus(cur, 6 - (cur % 7)); }
  };

  // Default roving target: selected start in view → today in view → 1st of month.
  const idxOf = (n: number) => cells.findIndex((c) => dayNum(c) === n && c.getMonth() === view.m);
  const roving = focusIdx >= 0 ? focusIdx : (sN != null && idxOf(sN) >= 0 ? idxOf(sN) : idxOf(today) >= 0 ? idxOf(today) : offset);

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="cal-nav" onClick={() => shift(-1)} aria-label="이전 달">‹</button>
        <span className="cal-title" aria-live="polite">{view.y}년 {view.m + 1}월</span>
        <button type="button" className="cal-nav" onClick={() => shift(1)} aria-label="다음 달">›</button>
      </div>
      <div className="cal-grid cal-wd" aria-hidden="true">
        {WD.map((w, i) => <span key={w} className={`cal-wd-cell${i === 0 ? " sun" : i === 6 ? " sat" : ""}`}>{w}</span>)}
      </div>
      <div className="cal-body" role="grid" aria-label="날짜 선택" ref={gridRef} onKeyDown={onGridKey} onMouseLeave={() => setHover(null)}>
        {Array.from({ length: 6 }, (_, wi) => (
          <div className="cal-row" role="row" key={wi}>
            {cells.slice(wi * 7, wi * 7 + 7).map((d, ci) => {
              const i = wi * 7 + ci;
              const n = dayNum(d);
              const disabled = n > maxN;
              const isStart = n === sN;
              const isEnd = rangeEnd != null && n === rangeEnd;
              const inRange = sN != null && rangeEnd != null && n >= sN && n <= rangeEnd;
              const cls = ["cal-day"];
              if (d.getMonth() !== view.m) cls.push("other");
              if (n === today) cls.push("today");
              if (inRange) cls.push("in-range");
              if (isStart) cls.push("start");
              if (isEnd) cls.push("end");
              return (
                <button
                  key={i}
                  type="button"
                  role="gridcell"
                  data-idx={i}
                  disabled={disabled}
                  tabIndex={i === roving ? 0 : -1}
                  className={cls.join(" ")}
                  aria-label={`${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`}
                  aria-current={isStart || isEnd ? "date" : undefined}
                  onMouseEnter={() => !disabled && setHover(d)}
                  onClick={() => click(d)}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {picking && <div className="cal-hint" role="status">종료일을 선택해주세요</div>}
    </div>
  );
}
