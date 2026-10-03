// Package sampling provides tail-ish trace sampling at the gateway ingest edge.
//
// Decision per span (fast, in-memory, no DB on the hot path):
//   - errors and slow spans are ALWAYS kept (priority) — sampling never hides
//     problems.
//   - otherwise keep with the service's keep_rate, decided deterministically by
//     hashing the trace id so a trace's normal spans keep-or-drop consistently
//     across batches.
//   - no rule for the service/tenant → keep everything (rate 1.0). Sampling is
//     strictly opt-in, so an empty config never drops data.
//
// Rules are refreshed from ClickHouse in the background; volume counters flush to
// apm.ingest_stats periodically. Both are off the request path.
package sampling

import (
	"context"
	"hash/fnv"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/heejune/apm/internal/buffer"
	"github.com/heejune/apm/internal/otlp"
	"github.com/heejune/apm/internal/storage"
)

// Store is the subset of storage the sampler needs.
type Store interface {
	AllSamplingRules(ctx context.Context) (map[string][]storage.SamplingRule, error)
	InsertIngestStat(ctx context.Context, st storage.IngestStat) error
}

// slowNs: spans slower than this are always kept regardless of rate.
const slowNs = uint64(time.Second)

type Sampler struct {
	next  buffer.Port
	store Store
	mu    sync.RWMutex
	rules map[string]map[string]float64 // tenant -> service -> keep_rate ("*"=default)
	// per-tenant volume counters, accumulated between stat flushes.
	cmu     sync.Mutex
	counts  map[string]*[3]uint64 // tenant -> {received, kept, dropped}
	enabled atomic.Bool           // any rule present → sampling active
}

func New(next buffer.Port, store Store) *Sampler {
	return &Sampler{next: next, store: store, rules: map[string]map[string]float64{}, counts: map[string]*[3]uint64{}}
}

// Publish filters the batch, records volume, and forwards kept spans.
func (s *Sampler) Publish(ctx context.Context, spans []otlp.Span) error {
	if !s.enabled.Load() {
		s.bump("", len(spans), len(spans), 0) // count-through when inactive
		return s.next.Publish(ctx, spans)
	}
	kept := make([]otlp.Span, 0, len(spans))
	byTenant := map[string][2]int{} // tenant -> {received, kept}
	for _, sp := range spans {
		r := byTenant[sp.TenantID]
		r[0]++
		if s.keep(sp) {
			kept = append(kept, sp)
			r[1]++
		}
		byTenant[sp.TenantID] = r
	}
	for t, r := range byTenant {
		s.bump(t, r[0], r[1], r[0]-r[1])
	}
	if len(kept) == 0 {
		return nil
	}
	return s.next.Publish(ctx, kept)
}

func (s *Sampler) keep(sp otlp.Span) bool {
	if sp.StatusCode == "ERROR" || sp.DurationNs > slowNs {
		return true // priority: never drop errors or slow spans
	}
	rate := s.rateFor(sp.TenantID, sp.ServiceName)
	if rate >= 1 {
		return true
	}
	if rate <= 0 {
		return false
	}
	h := fnv.New64a()
	h.Write([]byte(sp.TraceID))
	return float64(h.Sum64()%10000)/10000 < rate
}

func (s *Sampler) rateFor(tenant, service string) float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	svc, ok := s.rules[tenant]
	if !ok {
		return 1
	}
	if r, ok := svc[service]; ok {
		return r
	}
	if r, ok := svc["*"]; ok {
		return r
	}
	return 1
}

func (s *Sampler) bump(tenant string, recv, kept, dropped int) {
	s.cmu.Lock()
	c, ok := s.counts[tenant]
	if !ok {
		c = &[3]uint64{}
		s.counts[tenant] = c
	}
	c[0] += uint64(recv)
	c[1] += uint64(kept)
	c[2] += uint64(dropped)
	s.cmu.Unlock()
}

// Run refreshes rules and flushes ingest stats until ctx is cancelled.
func (s *Sampler) Run(ctx context.Context) {
	s.refresh(ctx)
	refresh := time.NewTicker(10 * time.Second)
	flush := time.NewTicker(15 * time.Second)
	defer refresh.Stop()
	defer flush.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-refresh.C:
			s.refresh(ctx)
		case <-flush.C:
			s.flush(ctx)
		}
	}
}

func (s *Sampler) refresh(ctx context.Context) {
	all, err := s.store.AllSamplingRules(ctx)
	if err != nil {
		log.Printf("sampling: refresh: %v", err)
		return
	}
	m := map[string]map[string]float64{}
	any := false
	for tenant, rules := range all {
		svc := map[string]float64{}
		for _, r := range rules {
			if r.Enabled {
				svc[r.Service] = r.KeepRate
				any = true
			}
		}
		m[tenant] = svc
	}
	s.mu.Lock()
	s.rules = m
	s.mu.Unlock()
	s.enabled.Store(any)
}

func (s *Sampler) flush(ctx context.Context) {
	s.cmu.Lock()
	snapshot := s.counts
	s.counts = map[string]*[3]uint64{}
	s.cmu.Unlock()
	now := time.Now().UTC()
	for tenant, c := range snapshot {
		if c[0] == 0 {
			continue
		}
		t := tenant
		if t == "" {
			t = "default"
		}
		if err := s.store.InsertIngestStat(ctx, storage.IngestStat{
			Tenant: t, Ts: now, Received: c[0], Kept: c[1], Dropped: c[2],
		}); err != nil {
			log.Printf("sampling: flush stats: %v", err)
		}
	}
}
