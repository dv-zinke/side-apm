package query

import "testing"

// steady baseline (~400) with small noise, then a sustained spike in the last
// complete buckets — plus a trailing incomplete bucket that must be ignored.
func spikeSeries(base float64, spike float64) []float64 {
	s := []float64{}
	for i := 0; i < 14; i++ {
		n := base
		if i%2 == 0 {
			n += 5
		} else {
			n -= 5
		}
		s = append(s, n)
	}
	// last 3 complete buckets spike
	s = append(s, spike, spike, spike)
	// trailing incomplete current minute (low) — should be dropped
	s = append(s, base*0.5)
	return s
}

func TestDetect_SpikeFires(t *testing.T) {
	a, ok := detect("PaymentService", "p95_ms", spikeSeries(400, 1600), 300, 0.5, false)
	if !ok {
		t.Fatal("expected p95 spike to be detected")
	}
	if a.Direction != "up" || a.Z < 3 {
		t.Fatalf("bad anomaly: %+v", a)
	}
}

func TestDetect_SteadyIsQuiet(t *testing.T) {
	// stable ~400 series, no spike → no anomaly (dual gate).
	steady := []float64{}
	for i := 0; i < 20; i++ {
		if i%2 == 0 {
			steady = append(steady, 403)
		} else {
			steady = append(steady, 397)
		}
	}
	if _, ok := detect("S", "p95_ms", steady, 300, 0.5, false); ok {
		t.Fatal("steady series must not alert")
	}
}

func TestDetect_TinyStddevNoFalsePositive(t *testing.T) {
	// rock-steady throughput ~712 with a 3% dip — huge z but tiny relative
	// change must NOT fire (this was the original false positive).
	thr := []float64{}
	for i := 0; i < 17; i++ {
		thr = append(thr, 712)
	}
	thr = append(thr, 691, 691, 691, 690) // ~3% dip + incomplete
	if _, ok := detect("S", "throughput", thr, 5, 0.3, true); ok {
		t.Fatal("3% dip on stable throughput must not alert")
	}
}

func TestDetect_RealDropFires(t *testing.T) {
	// throughput baseline ~700 (with noise) then a real 40% drop → down anomaly.
	thr := []float64{}
	for i := 0; i < 14; i++ {
		if i%2 == 0 {
			thr = append(thr, 707)
		} else {
			thr = append(thr, 693)
		}
	}
	thr = append(thr, 410, 415, 405, 200) // ~41% drop + incomplete
	a, ok := detect("S", "throughput", thr, 5, 0.3, true)
	if !ok || a.Direction != "down" {
		t.Fatalf("expected throughput drop anomaly, got ok=%v a=%+v", ok, a)
	}
}
