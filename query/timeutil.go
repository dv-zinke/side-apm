package query

import (
	"strconv"
	"time"
)

// parseTimeParam accepts RFC3339(/Nano), epoch milliseconds, or epoch seconds.
// Returns ok=false for empty or unrecognized input so callers can fall back to
// a default window instead of silently mis-parsing (e.g. epoch-ms → zero time).
func parseTimeParam(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC(), true
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), true
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		// Heuristic: 13+ digits → milliseconds, else seconds.
		if n >= 1e12 {
			return time.UnixMilli(n).UTC(), true
		}
		return time.Unix(n, 0).UTC(), true
	}
	return time.Time{}, false
}

// resolveWindow returns [from, to] from query params, defaulting `to` to now and
// `from` to now-defaultDur when a param is absent or unparseable.
func resolveWindow(fromParam, toParam string, defaultDur time.Duration) (from, to time.Time) {
	to = time.Now().UTC()
	if t, ok := parseTimeParam(toParam); ok {
		to = t
	}
	from = to.Add(-defaultDur)
	if f, ok := parseTimeParam(fromParam); ok {
		from = f
	}
	return from, to
}
