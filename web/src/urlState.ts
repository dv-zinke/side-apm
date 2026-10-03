// Tiny URL query-string state layer — no router dependency, matching the app's
// minimalist architecture. Lets view + time selection live in the address bar so
// reloads survive and links are shareable/bookmarkable.

export function getParam(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key);
}

// Merge a patch into the current query string. Keys with null/"" are removed.
function apply(patch: Record<string, string | null>, mode: "replace" | "push") {
  const p = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") p.delete(k);
    else p.set(k, v);
  }
  const qs = p.toString();
  const url = (qs ? `?${qs}` : window.location.pathname) + window.location.hash;
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

// replaceParams: edit the current history entry (no new back-stack entry) — for
// changes within a view, e.g. the time window.
export function replaceParams(patch: Record<string, string | null>) {
  apply(patch, "replace");
}

// pushParams: add a history entry so browser back/forward navigates — for
// coarse navigation like switching views.
export function pushParams(patch: Record<string, string | null>) {
  apply(patch, "push");
}
