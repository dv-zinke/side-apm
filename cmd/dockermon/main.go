// dockermon — a tiny Docker stats collector. Reads the Docker Engine API over
// the mounted socket, computes per-container CPU%/mem/net, and posts to the APM
// gateway on an interval. No external deps.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const apiVer = "v1.43"

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	sock := getenv("DOCKER_SOCK", "/var/run/docker.sock")
	gateway := getenv("APM_GATEWAY", "http://gateway:4318") + "/v1/infra"
	// Only collect containers whose name starts with this prefix (comma-list),
	// so we don't scrape unrelated host containers. Empty = all.
	prefixes := splitCSV(getenv("DOCKER_NAME_PREFIX", "deploy-"))
	interval := 5 * time.Second

	docker := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		},
	}}
	out := &http.Client{Timeout: 5 * time.Second}

	log.Printf("dockermon: socket=%s gateway=%s interval=%s prefixes=%v", sock, gateway, interval, prefixes)
	for {
		if err := collect(docker, out, gateway, prefixes); err != nil {
			log.Printf("dockermon: %v", err)
		}
		time.Sleep(interval)
	}
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func matchesPrefix(name string, prefixes []string) bool {
	if len(prefixes) == 0 {
		return true
	}
	for _, p := range prefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

type containerLite struct {
	ID    string   `json:"Id"`
	Names []string `json:"Names"`
	Image string   `json:"Image"`
	State string   `json:"State"`
}

type statJSON struct {
	CPUStats    cpuStats `json:"cpu_stats"`
	PreCPUStats cpuStats `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
}
type cpuStats struct {
	CPUUsage struct {
		TotalUsage  uint64   `json:"total_usage"`
		PercpuUsage []uint64 `json:"percpu_usage"`
	} `json:"cpu_usage"`
	SystemCPUUsage uint64 `json:"system_cpu_usage"`
	OnlineCPUs     uint64 `json:"online_cpus"`
}

type outStat struct {
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

func collect(docker, out *http.Client, gateway string, prefixes []string) error {
	var list []containerLite
	if err := getJSON(docker, "http://d/"+apiVer+"/containers/json", &list); err != nil {
		return err
	}
	stats := make([]outStat, 0, len(list))
	for _, c := range list {
		name := c.ID[:12]
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		if !matchesPrefix(name, prefixes) {
			continue
		}
		var s statJSON
		if err := getJSON(docker, "http://d/"+apiVer+"/containers/"+c.ID+"/stats?stream=false", &s); err != nil {
			continue
		}
		memCache := s.MemoryStats.Stats["inactive_file"]
		memUsed := s.MemoryStats.Usage
		if memUsed > memCache {
			memUsed -= memCache
		}
		memPct := 0.0
		if s.MemoryStats.Limit > 0 {
			memPct = float64(memUsed) / float64(s.MemoryStats.Limit) * 100
		}
		var rx, tx uint64
		for _, n := range s.Networks {
			rx += n.RxBytes
			tx += n.TxBytes
		}
		stats = append(stats, outStat{
			TS: time.Now().UnixMilli(), Container: name, Image: c.Image, Status: c.State,
			CPUPct: cpuPercent(s), MemBytes: memUsed, MemLimit: s.MemoryStats.Limit, MemPct: memPct, NetRx: rx, NetTx: tx,
		})
	}
	body, _ := json.Marshal(map[string]any{"containers": stats})
	resp, err := out.Post(gateway, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	return nil
}

func cpuPercent(s statJSON) float64 {
	cpuDelta := float64(s.CPUStats.CPUUsage.TotalUsage) - float64(s.PreCPUStats.CPUUsage.TotalUsage)
	sysDelta := float64(s.CPUStats.SystemCPUUsage) - float64(s.PreCPUStats.SystemCPUUsage)
	if sysDelta <= 0 || cpuDelta < 0 {
		return 0
	}
	ncpu := float64(s.CPUStats.OnlineCPUs)
	if ncpu == 0 {
		ncpu = float64(len(s.CPUStats.CPUUsage.PercpuUsage))
	}
	if ncpu == 0 {
		ncpu = 1
	}
	return (cpuDelta / sysDelta) * ncpu * 100
}

func getJSON(c *http.Client, url string, v any) error {
	resp, err := c.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(v)
}
