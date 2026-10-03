package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/heejune/apm/internal/storage"
)

// Regression: RUM CORS — sendBeacon preflight — /qa 2026-10-04
// navigator.sendBeacon always uses credentials mode "include"; a wildcard
// Access-Control-Allow-Origin makes the browser reject the preflight, so the
// RUM beacon failed every ~10s. The handler must reflect the Origin and allow
// credentials when an Origin header is present.
func TestRumHandler_CORSCredentialedPreflight(t *testing.T) {
	h := RumHandler(func(context.Context, []storage.RumEvent) error { return nil })
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodOptions, "/v1/rum", nil)
	r.Header.Set("Origin", "http://localhost:3000")
	h(w, r)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("Allow-Origin = %q, want the reflected origin (not wildcard)", got)
	}
	if got := w.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Allow-Credentials = %q, want true", got)
	}
	if w.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", w.Code)
	}
}

// No Origin header (server-side SDK, curl) still gets the permissive wildcard.
func TestRumHandler_CORSNoOriginWildcard(t *testing.T) {
	h := RumHandler(func(context.Context, []storage.RumEvent) error { return nil })
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodOptions, "/v1/rum", nil)
	h(w, r)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Allow-Origin = %q, want * for origin-less caller", got)
	}
}
