// Shared time-range picker for "조회" views (dashboard, RED, …). One source of
// truth for the window presets, the ISO window they resolve to, and the coarser
// bucket step long windows use so charts/payloads stay sane.

export type RangeId = "15m" | "1h" | "6h" | "24h";
export type Range = { id: RangeId; label: string; minutes: number; step: number };

export const RANGES: Range[] = [
  { id: "15m", label: "15분", minutes: 15, step: 1 },
  { id: "1h", label: "1시간", minutes: 60, step: 1 },
  { id: "6h", label: "6시간", minutes: 360, step: 5 },
  { id: "24h", label: "24시간", minutes: 1440, step: 15 },
];

export const DEFAULT_RANGE: RangeId = "1h";
export const rangeById = (id: RangeId): Range => RANGES.find((r) => r.id === id) ?? RANGES[1];

// Resolve the [from, to] window. Bucket `nowMs` to the minute at the call site so
// the query key stays stable between refetches (avoids a render loop).
export function rangeWindow(r: Range, nowMs: number): { fromISO: string; toISO: string } {
  const to = new Date(nowMs).toISOString();
  const from = new Date(nowMs - r.minutes * 60_000).toISOString();
  return { fromISO: from, toISO: to };
}

// A filter, not a tab panel — radiogroup semantics (not tablist) so screen
// readers announce "라디오 버튼 2/4" rather than promising a panel switch.
export function TimeRange({ value, onChange }: { value: RangeId; onChange: (id: RangeId) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="조회 기간">
      {RANGES.map((r) => (
        <button key={r.id} role="radio" aria-checked={value === r.id} className="seg" aria-current={value === r.id} onClick={() => onChange(r.id)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}
