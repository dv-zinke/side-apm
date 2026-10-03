package query

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type ChannelDTO struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"` // slack | webhook | pagerduty
	Target  string `json:"target"`
	Enabled bool   `json:"enabled"`
}

type NotificationDTO struct {
	Ts          string `json:"ts"`
	RuleName    string `json:"ruleName"`
	ChannelName string `json:"channelName"`
	Type        string `json:"type"`
	State       string `json:"state"`
	OK          bool   `json:"ok"`
	Error       string `json:"error"`
}

var validChannelType = map[string]bool{"slack": true, "webhook": true, "pagerduty": true}

func registerChannels(mux *http.ServeMux, r Reader) {
	mux.HandleFunc("GET /api/v1/alert-channels", func(w http.ResponseWriter, req *http.Request) {
		chs, err := r.ListChannels(req.Context(), tenantOf(req))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]ChannelDTO, 0, len(chs))
		for _, c := range chs {
			out = append(out, ChannelDTO{c.ID, c.Name, c.Type, c.Target, c.Enabled})
		}
		writeJSON(w, out)
	})

	mux.HandleFunc("POST /api/v1/alert-channels", func(w http.ResponseWriter, req *http.Request) {
		var dto ChannelDTO
		if err := json.NewDecoder(req.Body).Decode(&dto); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if dto.Name == "" || !validChannelType[dto.Type] || dto.Target == "" {
			http.Error(w, "name, type(slack|webhook|pagerduty), target required", http.StatusBadRequest)
			return
		}
		if dto.ID == "" {
			dto.ID = newID()
		}
		if err := r.UpsertChannel(req.Context(), tenantOf(req), storage.AlertChannel{
			ID: dto.ID, Name: dto.Name, Type: dto.Type, Target: dto.Target, Enabled: dto.Enabled,
		}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, dto)
	})

	mux.HandleFunc("DELETE /api/v1/alert-channels/{id}", func(w http.ResponseWriter, req *http.Request) {
		if err := r.DeleteChannel(req.Context(), tenantOf(req), req.PathValue("id")); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	// Send a test notification to a channel so users can verify wiring before an
	// incident. Logs to the delivery history like a real send.
	mux.HandleFunc("POST /api/v1/alert-channels/{id}/test", func(w http.ResponseWriter, req *http.Request) {
		tenant := tenantOf(req)
		chs, err := r.ListChannels(req.Context(), tenant)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		var ch *storage.AlertChannel
		for i := range chs {
			if chs[i].ID == req.PathValue("id") {
				ch = &chs[i]
				break
			}
		}
		if ch == nil {
			http.Error(w, "channel not found", http.StatusNotFound)
			return
		}
		m := notifMeta{ruleID: "test", ruleName: "테스트 알림", state: "firing", text: "🔔 [테스트] APM 알림 연결이 정상입니다 · " + ch.Name}
		sendErr := sendToChannel(*ch, m)
		n := storage.Notification{
			Ts: time.Now().UTC(), RuleID: "test", RuleName: "테스트 알림",
			ChannelID: ch.ID, ChannelName: ch.Name, Type: ch.Type, State: "test", OK: sendErr == nil,
		}
		if sendErr != nil {
			n.Error = sendErr.Error()
		}
		_ = r.InsertNotification(req.Context(), tenant, n)
		if sendErr != nil {
			http.Error(w, sendErr.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	})

	mux.HandleFunc("GET /api/v1/notifications", func(w http.ResponseWriter, req *http.Request) {
		limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
		ns, err := r.ListNotifications(req.Context(), tenantOf(req), limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]NotificationDTO, 0, len(ns))
		for _, n := range ns {
			out = append(out, NotificationDTO{
				Ts: n.Ts.Format(time.RFC3339), RuleName: n.RuleName, ChannelName: n.ChannelName,
				Type: n.Type, State: n.State, OK: n.OK, Error: n.Error,
			})
		}
		writeJSON(w, out)
	})
}
