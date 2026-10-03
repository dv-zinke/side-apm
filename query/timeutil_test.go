package query

import (
	"testing"
	"time"
)

func TestParseTimeParam(t *testing.T) {
	want := time.Date(2026, 8, 14, 3, 30, 0, 0, time.UTC)
	cases := map[string]struct {
		in string
		ok bool
	}{
		"rfc3339":  {"2026-08-14T03:30:00Z", true},
		"epoch_ms": {"1786678200000", true},
		"epoch_s":  {"1786678200", true},
		"empty":    {"", false},
		"garbage":  {"not-a-time", false},
	}
	for name, c := range cases {
		got, ok := parseTimeParam(c.in)
		if ok != c.ok {
			t.Errorf("%s: ok=%v want %v", name, ok, c.ok)
			continue
		}
		if ok && !got.Equal(want) {
			t.Errorf("%s: got %v want %v", name, got, want)
		}
	}
}

func TestResolveWindowDefaults(t *testing.T) {
	// Unparseable inputs must fall back to the default window, not zero time.
	from, to := resolveWindow("garbage", "", time.Hour)
	if to.IsZero() || from.IsZero() {
		t.Fatal("resolveWindow returned zero time on fallback")
	}
	if d := to.Sub(from); d < 59*time.Minute || d > 61*time.Minute {
		t.Errorf("default window = %v, want ~1h", d)
	}
}
