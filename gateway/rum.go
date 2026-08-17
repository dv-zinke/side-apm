package gateway

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/heejune/apm/internal/storage"
)

// RUM browser payload: one session's batch of events.
type rumPayload struct {
	SessionID string     `json:"sessionId"`
	Page      string     `json:"page"`
	UA        string     `json:"ua"`
	Events    []rumEvent `json:"events"`
}
type rumEvent struct {
	Type     string  `json:"type"`
	TS       int64   `json:"ts"` // epoch ms
	Target   string  `json:"target,omitempty"`
	Message  string  `json:"message,omitempty"`
	Stack    string  `json:"stack,omitempty"`
	Metric   string  `json:"metric,omitempty"`
	Value    float64 `json:"value,omitempty"`
	URL      string  `json:"url,omitempty"`
	Status   uint16  `json:"status,omitempty"`
	Page     string  `json:"page,omitempty"`
}

func RumHandler(publish func(ctx context.Context, evs []storage.RumEvent) error) http.HandlerFunc {
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
		var p rumPayload
		if err := json.Unmarshal(body, &p); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		out := make([]storage.RumEvent, 0, len(p.Events))
		for _, e := range p.Events {
			ts := time.UnixMilli(e.TS).UTC()
			if e.TS == 0 {
				ts = time.Now().UTC()
			}
			page := e.Page
			if page == "" {
				page = p.Page
			}
			out = append(out, storage.RumEvent{
				TenantID: tenantFromReq(r), Time: ts, SessionID: p.SessionID, Type: e.Type,
				Page: page, Target: e.Target, Message: e.Message, ErrStack: e.Stack,
				Metric: e.Metric, Value: e.Value, URL: e.URL, Status: e.Status, UA: p.UA,
			})
		}
		if err := publish(r.Context(), out); err != nil {
			http.Error(w, "publish failed", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

type replayPayload struct {
	SessionID string            `json:"sessionId"`
	Page      string            `json:"page"`
	Message   string            `json:"message"`
	Events    []json.RawMessage `json:"events"`
}

// RumReplayHandler stores an rrweb event stream (session replay around an error).
func RumReplayHandler(store interface {
	InsertRumReplay(ctx context.Context, tenant string, r storage.RumReplay) error
}) http.HandlerFunc {
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
		body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}
		var p replayPayload
		if err := json.Unmarshal(body, &p); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if len(p.Events) == 0 {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		events, _ := json.Marshal(p.Events)
		id := make([]byte, 8)
		_, _ = rand.Read(id)
		rec := storage.RumReplay{
			ID: hex.EncodeToString(id), Time: time.Now().UTC(), SessionID: p.SessionID,
			Page: p.Page, Message: p.Message, Events: string(events),
		}
		if err := store.InsertRumReplay(r.Context(), tenantFromReq(r), rec); err != nil {
			http.Error(w, "publish failed", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
