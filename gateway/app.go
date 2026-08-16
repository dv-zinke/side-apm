package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type appPayload struct {
	SessionID  string     `json:"sessionId"`
	AppVersion string     `json:"appVersion"`
	Platform   string     `json:"platform"`
	OSVersion  string     `json:"osVersion"`
	Device     string     `json:"device"`
	Events     []appEvent `json:"events"`
}
type appEvent struct {
	Type       string  `json:"type"`
	TS         int64   `json:"ts"`
	Screen     string  `json:"screen,omitempty"`
	DurationMs float64 `json:"durationMs,omitempty"`
	LaunchType string  `json:"launchType,omitempty"`
	Message    string  `json:"message,omitempty"`
	Stack      string  `json:"stack,omitempty"`
	URL        string  `json:"url,omitempty"`
	Status     uint16  `json:"status,omitempty"`
	Fatal      bool    `json:"fatal,omitempty"`
}

// AppHandler ingests mobile app monitoring events (iOS/Android SDK).
func AppHandler(publish func(ctx context.Context, evs []storage.AppEvent) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}
		var p appPayload
		if err := json.Unmarshal(body, &p); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		out := make([]storage.AppEvent, 0, len(p.Events))
		for _, e := range p.Events {
			ts := time.UnixMilli(e.TS).UTC()
			if e.TS == 0 {
				ts = time.Now().UTC()
			}
			fatal := uint8(0)
			if e.Fatal {
				fatal = 1
			}
			out = append(out, storage.AppEvent{
				TenantID: defaultTenant, Time: ts, SessionID: p.SessionID, AppVersion: p.AppVersion,
				Platform: p.Platform, OSVersion: p.OSVersion, Device: p.Device, Type: e.Type,
				Screen: e.Screen, DurationMs: e.DurationMs, LaunchType: e.LaunchType,
				Message: e.Message, ErrStack: e.Stack, URL: e.URL, Status: e.Status, Fatal: fatal,
			})
		}
		if err := publish(r.Context(), out); err != nil {
			http.Error(w, "publish failed", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
