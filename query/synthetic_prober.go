package query

import (
	"context"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/heejune/apm/internal/storage"
)

// Monitor is one synthetic target: a friendly name and a URL to probe.
type Monitor struct {
	Name string
	URL  string
}

// SyntheticWriter is the storage subset the prober needs.
type SyntheticWriter interface {
	InsertSyntheticChecks(ctx context.Context, cs []storage.SyntheticCheck) error
}

// SyntheticProber periodically HTTP-probes each monitor and records up/down +
// latency, powering the uptime view. "up" = a response arrived within timeout
// with status < 500; connection error / timeout / 5xx = down.
type SyntheticProber struct {
	store    SyntheticWriter
	monitors []Monitor
	interval time.Duration
	client   *http.Client
}

func NewSyntheticProber(store SyntheticWriter, monitors []Monitor, interval time.Duration) *SyntheticProber {
	if interval <= 0 {
		interval = 15 * time.Second
	}
	return &SyntheticProber{
		store: store, monitors: monitors, interval: interval,
		client: &http.Client{Timeout: 5 * time.Second},
	}
}

// ParseMonitors reads "name|url,name|url" (falls back to a sensible default set
// probing the local stack + one external endpoint).
func ParseMonitors(spec string) []Monitor {
	if strings.TrimSpace(spec) == "" {
		return []Monitor{
			{Name: "웹 콘솔", URL: "http://web:80/"},
			{Name: "쿼리 API", URL: "http://query:8080/api/v1/services"},
			{Name: "ClickHouse", URL: "http://clickhouse:8123/ping"},
			{Name: "외부(google)", URL: "https://www.google.com/generate_204"},
		}
	}
	var out []Monitor
	for _, part := range strings.Split(spec, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "|", 2)
		if len(kv) == 2 && kv[0] != "" && kv[1] != "" {
			out = append(out, Monitor{Name: kv[0], URL: kv[1]})
		}
	}
	return out
}

func (p *SyntheticProber) Run(ctx context.Context) {
	if len(p.monitors) == 0 {
		return
	}
	log.Printf("synthetics: probing %d monitors every %s", len(p.monitors), p.interval)
	t := time.NewTicker(p.interval)
	defer t.Stop()
	p.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.tick(ctx)
		}
	}
}

func (p *SyntheticProber) tick(ctx context.Context) {
	// Probe concurrently so one slow/timing-out monitor doesn't push the tick
	// past its interval and drop checks for the others.
	checks := make([]storage.SyntheticCheck, len(p.monitors))
	var wg sync.WaitGroup
	for i, m := range p.monitors {
		wg.Add(1)
		go func(i int, m Monitor) {
			defer wg.Done()
			checks[i] = p.probe(ctx, m)
		}(i, m)
	}
	wg.Wait()
	if err := p.store.InsertSyntheticChecks(ctx, checks); err != nil {
		log.Printf("synthetics: insert: %v", err)
	}
}

func (p *SyntheticProber) probe(ctx context.Context, m Monitor) storage.SyntheticCheck {
	c := storage.SyntheticCheck{TenantID: defaultTenant, Time: time.Now().UTC(), Monitor: m.Name, URL: m.URL}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.URL, nil)
	if err != nil {
		c.Err = err.Error()
		return c
	}
	start := time.Now()
	resp, err := p.client.Do(req)
	c.LatencyMs = float64(time.Since(start).Microseconds()) / 1000
	if err != nil {
		c.Err = err.Error()
		return c
	}
	defer resp.Body.Close()
	c.Status = uint16(resp.StatusCode)
	if resp.StatusCode < 500 {
		c.Up = 1
	} else {
		c.Err = resp.Status
	}
	return c
}
