package storage

import (
	"math"
	"testing"
)

func TestQuantileFromBuckets(t *testing.T) {
	// bounds (ms) upper edges; counts includes trailing +Inf bucket.
	// 100 samples: 50 in (0,100], 40 in (100,500], 10 in (500,1000], 0 >1000.
	bounds := []float64{100, 500, 1000}
	counts := []uint64{50, 40, 10, 0}

	p50 := quantileFromBuckets(bounds, counts, 0.5) // 50th sample = edge of first bucket
	if math.Abs(p50-100) > 1 {
		t.Errorf("p50 = %.1f, want ~100", p50)
	}
	p95 := quantileFromBuckets(bounds, counts, 0.95) // 95th sample in (500,1000]
	if p95 <= 500 || p95 > 1000 {
		t.Errorf("p95 = %.1f, want in (500,1000]", p95)
	}
}

func TestInterpCumulativeApdex(t *testing.T) {
	// T=100ms. 50 satisfied (≤100), 40 tolerating (≤400 within (100,500]),
	bounds := []float64{100, 500, 1000}
	counts := []uint64{50, 40, 10, 0}
	total := 100.0

	sat := interpCumulative(bounds, counts, 100)   // exactly first edge
	tol := interpCumulative(bounds, counts, 400) - sat
	score := (sat + tol/2) / total
	if math.Abs(sat-50) > 0.5 {
		t.Errorf("satisfied = %.1f, want 50", sat)
	}
	// 400 is 75% into (100,500] → 0.75*40 = 30 tolerating
	if math.Abs(tol-30) > 0.5 {
		t.Errorf("tolerating = %.1f, want 30", tol)
	}
	if score <= 0 || score > 1 {
		t.Errorf("apdex score = %.3f out of range", score)
	}
}
