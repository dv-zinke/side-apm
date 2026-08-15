package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type infraPayload struct {
	Containers []infraStat `json:"containers"`
}
type infraStat struct {
	TS        int64   `json:"ts"`
	Container string  `json:"container"`
	Image     string  `json:"image"`
	Status    string  `json:"status"`
	CPUPct    float64 `json:"cpuPct"`
	MemBytes  uint64  `json:"memBytes"`
	MemLimit  uint64  `json:"memLimit"`
	MemPct    float64 `json:"memPct"`
	NetRx     uint64  `json:"netRx"`
	NetTx     uint64  `json:"netTx"`
}

func InfraHandler(publish func(ctx context.Context, cs []storage.ContainerStat) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}
		var p infraPayload
		if err := json.Unmarshal(body, &p); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		out := make([]storage.ContainerStat, 0, len(p.Containers))
		for _, c := range p.Containers {
			ts := time.UnixMilli(c.TS).UTC()
			if c.TS == 0 {
				ts = time.Now().UTC()
			}
			out = append(out, storage.ContainerStat{
				TenantID: defaultTenant, Time: ts, Container: c.Container, Image: c.Image, Status: c.Status,
				CPUPct: c.CPUPct, MemBytes: c.MemBytes, MemLimit: c.MemLimit, MemPct: c.MemPct, NetRx: c.NetRx, NetTx: c.NetTx,
			})
		}
		if err := publish(r.Context(), out); err != nil {
			http.Error(w, "publish failed", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
