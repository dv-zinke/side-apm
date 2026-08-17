package query

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/pprof/profile"
	"github.com/heejune/apm/internal/storage"
)

type ProfileTarget struct {
	Name string
	URL  string // base, e.g. http://gateway:6060
}

type ProfileWriter interface {
	InsertProfile(ctx context.Context, tenant string, p storage.Profile) error
}

// Profiler periodically scrapes CPU + heap pprof from Go services, parses them
// into flame trees + top-function tables, and stores them — continuous profiling.
type Profiler struct {
	store    ProfileWriter
	targets  []ProfileTarget
	interval time.Duration
	client   *http.Client
}

func NewProfiler(store ProfileWriter, targets []ProfileTarget, interval time.Duration) *Profiler {
	if interval <= 0 {
		interval = 60 * time.Second
	}
	return &Profiler{store: store, targets: targets, interval: interval, client: &http.Client{Timeout: 20 * time.Second}}
}

// ParseProfileTargets reads "name=url,name=url" (default: the local Go services).
func ParseProfileTargets(spec string) []ProfileTarget {
	if strings.TrimSpace(spec) == "" {
		return []ProfileTarget{
			{Name: "gateway", URL: "http://gateway:6060"},
			{Name: "query", URL: "http://localhost:6060"},
		}
	}
	var out []ProfileTarget
	for _, part := range strings.Split(spec, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) == 2 {
			out = append(out, ProfileTarget{Name: kv[0], URL: kv[1]})
		}
	}
	return out
}

func (p *Profiler) Run(ctx context.Context) {
	if len(p.targets) == 0 {
		return
	}
	log.Printf("profiler: %d targets every %s", len(p.targets), p.interval)
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

func (p *Profiler) tick(ctx context.Context) {
	for _, tg := range p.targets {
		p.scrape(ctx, tg, "cpu", tg.URL+"/debug/pprof/profile?seconds=5")
		p.scrape(ctx, tg, "heap", tg.URL+"/debug/pprof/heap")
	}
}

func (p *Profiler) scrape(ctx context.Context, tg ProfileTarget, ptype, url string) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := p.client.Do(req)
	if err != nil {
		log.Printf("profiler: %s %s: %v", tg.Name, ptype, err)
		return
	}
	defer resp.Body.Close()
	prof, err := profile.Parse(resp.Body)
	if err != nil {
		log.Printf("profiler: parse %s %s: %v", tg.Name, ptype, err)
		return
	}
	tree, top, unit, total := buildFlame(prof, ptype)
	if total == 0 {
		return
	}
	treeJSON, _ := json.Marshal(tree)
	topJSON, _ := json.Marshal(top)
	id := make([]byte, 8)
	_, _ = rand.Read(id)
	rec := storage.Profile{
		ID: hex.EncodeToString(id), Time: time.Now().UTC(), Target: tg.Name, Type: ptype,
		Unit: unit, Samples: total, Tree: string(treeJSON), Top: string(topJSON),
	}
	if err := p.store.InsertProfile(ctx, defaultTenant, rec); err != nil {
		log.Printf("profiler: insert: %v", err)
	}
}

type flameNode struct {
	Name     string       `json:"name"`
	Value    int64        `json:"value"`
	Children []*flameNode `json:"children,omitempty"`
}

type funcStat struct {
	Name string `json:"name"`
	Flat int64  `json:"flat"`
	Cum  int64  `json:"cum"`
}

// buildFlame turns a pprof profile into a top-down flame tree + per-function
// flat/cum stats, using the most meaningful value column for the profile type.
func buildFlame(p *profile.Profile, ptype string) (*flameNode, []funcStat, string, int64) {
	vi, unit := valueIndex(p, ptype)
	root := &flameNode{Name: "root"}
	flat := map[string]int64{}
	cum := map[string]int64{}
	var total int64
	for _, s := range p.Sample {
		if vi >= len(s.Value) {
			continue
		}
		v := s.Value[vi]
		if v <= 0 {
			continue
		}
		total += v
		// pprof stacks are leaf-first; reverse for a root→leaf flame.
		names := make([]string, 0, len(s.Location))
		for i := len(s.Location) - 1; i >= 0; i-- {
			names = append(names, locName(s.Location[i]))
		}
		node := root
		for _, n := range names {
			node = child(node, n)
			node.Value += v
		}
		if len(names) > 0 {
			flat[names[len(names)-1]] += v // self time = the leaf frame
		}
		for n := range uniq(names) {
			cum[n] += v // cumulative = appears anywhere in the stack (once per sample)
		}
	}
	tops := make([]funcStat, 0, len(cum))
	for n, c := range cum {
		tops = append(tops, funcStat{Name: n, Flat: flat[n], Cum: c})
	}
	sort.Slice(tops, func(i, j int) bool { return tops[i].Flat > tops[j].Flat })
	if len(tops) > 25 {
		tops = tops[:25]
	}
	root.Value = total
	return root, tops, unit, total
}

func valueIndex(p *profile.Profile, ptype string) (int, string) {
	prefer := "cpu"
	if ptype == "heap" {
		prefer = "inuse_space"
	}
	for i, st := range p.SampleType {
		if st.Type == prefer {
			return i, st.Unit
		}
	}
	// fall back to the last value column
	i := len(p.SampleType) - 1
	if i < 0 {
		return 0, ""
	}
	return i, p.SampleType[i].Unit
}

func locName(l *profile.Location) string {
	if l == nil || len(l.Line) == 0 || l.Line[0].Function == nil {
		return "(unknown)"
	}
	return l.Line[0].Function.Name
}

func child(n *flameNode, name string) *flameNode {
	for _, c := range n.Children {
		if c.Name == name {
			return c
		}
	}
	c := &flameNode{Name: name}
	n.Children = append(n.Children, c)
	return c
}

func uniq(names []string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}
