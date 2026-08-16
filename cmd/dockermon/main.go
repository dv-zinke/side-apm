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
	"strconv"
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

	procPath := getenv("HOST_PROC", "/host/proc")
	hostURL := getenv("APM_GATEWAY", "http://gateway:4318") + "/v1/infra/host"

	log.Printf("dockermon: socket=%s gateway=%s interval=%s prefixes=%v proc=%s", sock, gateway, interval, prefixes, procPath)
	var prevIdle, prevTotal uint64
	for {
		if err := collect(docker, out, gateway, prefixes); err != nil {
			log.Printf("dockermon: %v", err)
		}
		if pi, pt, err := collectHost(docker, out, hostURL, procPath, prevIdle, prevTotal); err != nil {
			log.Printf("dockermon: host: %v", err)
		} else {
			prevIdle, prevTotal = pi, pt
		}
		time.Sleep(interval)
	}
}

type dockerInfo struct {
	NCPU               int `json:"NCPU"`
	Containers         int `json:"Containers"`
	ContainersRunning  int `json:"ContainersRunning"`
}

// collectHost reads host CPU/memory/load from /proc and container counts from
// the Docker daemon, then posts one host snapshot.
func collectHost(docker, out *http.Client, hostURL, procPath string, prevIdle, prevTotal uint64) (uint64, uint64, error) {
	idle, total, err := readCPU(procPath)
	if err != nil {
		return prevIdle, prevTotal, err
	}
	cpuPct := 0.0
	if prevTotal > 0 && total > prevTotal {
		cpuPct = (1 - float64(idle-prevIdle)/float64(total-prevTotal)) * 100
	}
	memTotal, memAvail := readMem(procPath)
	memUsed := uint64(0)
	memPct := 0.0
	if memTotal > memAvail {
		memUsed = memTotal - memAvail
		memPct = float64(memUsed) / float64(memTotal) * 100
	}
	load1 := readLoad(procPath)
	var info dockerInfo
	_ = getJSON(docker, "http://d/"+apiVer+"/info", &info)

	body, _ := json.Marshal(map[string]any{
		"ts": time.Now().UnixMilli(), "cpuPct": cpuPct, "memUsed": memUsed, "memTotal": memTotal,
		"memPct": memPct, "ncpu": info.NCPU, "load1": load1,
		"containersRunning": info.ContainersRunning, "containersTotal": info.Containers,
	})
	if prevTotal > 0 { // skip the first tick (no delta yet)
		resp, err := out.Post(hostURL, "application/json", bytes.NewReader(body))
		if err != nil {
			return idle, total, err
		}
		_ = resp.Body.Close()
	}
	return idle, total, nil
}

func readCPU(procPath string) (idle, total uint64, err error) {
	b, err := os.ReadFile(procPath + "/stat")
	if err != nil {
		return 0, 0, err
	}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:]
		for i, f := range fields {
			v, _ := strconv.ParseUint(f, 10, 64)
			total += v
			if i == 3 || i == 4 { // idle + iowait
				idle += v
			}
		}
		return idle, total, nil
	}
	return 0, 0, nil
}

func readMem(procPath string) (total, avail uint64) {
	b, err := os.ReadFile(procPath + "/meminfo")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		v, _ := strconv.ParseUint(f[1], 10, 64)
		v *= 1024 // kB → bytes
		switch f[0] {
		case "MemTotal:":
			total = v
		case "MemAvailable:":
			avail = v
		}
	}
	return total, avail
}

func readLoad(procPath string) float64 {
	b, err := os.ReadFile(procPath + "/loadavg")
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return v
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
