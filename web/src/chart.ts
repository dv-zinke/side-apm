/* Theme-aware echarts palette. Derived from the theme in JS (not read
   from CSS vars) so charts and DOM switch skins in the same frame. */

type Theme = "dark" | "light";

export type ChartColors = {
  axis: string; split: string;
  tip: string; tipBorder: string; tipText: string;
  legend: string;
  accent: string; ok: string; warn: string; err: string;
  linkIdle: string;
};

export function chartColors(theme: Theme): ChartColors {
  return theme === "dark"
    ? {
        axis: "#7d8899", split: "#212936",
        tip: "#151b25", tipBorder: "#2c3644", tipText: "#e7ecf3",
        legend: "#aeb9c8",
        accent: "#38bdf8", ok: "#34d399", warn: "#fbbf24", err: "#f87171",
        linkIdle: "#3a4658",
      }
    : {
        axis: "#73726d", split: "#ededeb",
        tip: "#ffffff", tipBorder: "#e0e0dd", tipText: "#1f1f1e",
        legend: "#4d4d49",
        accent: "#2f8fdb", ok: "#2f9e6b", warn: "#c07d09", err: "#d93a41",
        linkIdle: "#c8c8c3",
      };
}
