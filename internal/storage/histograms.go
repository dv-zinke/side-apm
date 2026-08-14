package storage

import (
	"context"
	"time"

	"github.com/heejune/apm/internal/otlp"
)

// Duration histogram metric names emitted by common OTel HTTP instrumentation,
// in preference order (seconds-based new convention first, then legacy ms).
var durationHistogramNames = []string{
	"http.server.request.duration", // seconds (stable semconv)
	"http.server.duration",         // milliseconds (legacy)
}

func (s *Store) InsertHistograms(ctx context.Context, hs []otlp.Histogram) error {
	if len(hs) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO apm.metric_histograms")
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	for _, h := range hs {
		if _, err := stmt.ExecContext(ctx,
			h.TenantID, h.ServiceName, h.Name, h.Unit, h.Time, h.Bounds, h.Counts, h.Sum, h.Count,
		); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// aggBuckets sums histogram rows sharing the same bounds into one cumulative
// bucket vector. Returns bounds (upper edges, in ms), per-bucket counts, unit.
func (s *Store) aggBuckets(ctx context.Context, tenantID, service string, from, to time.Time) ([]float64, []uint64, string, error) {
	// Pick whichever duration histogram this service actually emits.
	var name, unit string
	for _, n := range durationHistogramNames {
		row := s.db.QueryRowContext(ctx,
			"SELECT unit FROM apm.metric_histograms WHERE tenant_id=? AND service_name=? AND metric_name=? AND ts>=? AND ts<=? LIMIT 1",
			tenantID, service, n, from, to)
		if err := row.Scan(&unit); err == nil {
			name = n
			break
		}
	}
	if name == "" {
		return nil, nil, "", nil
	}
	toMs := 1.0
	if unit == "s" { // seconds → ms
		toMs = 1000.0
	}

	rows, err := s.db.QueryContext(ctx,
		"SELECT bounds, counts FROM apm.metric_histograms WHERE tenant_id=? AND service_name=? AND metric_name=? AND ts>=? AND ts<=?",
		tenantID, service, name, from, to)
	if err != nil {
		return nil, nil, "", err
	}
	defer rows.Close()

	var boundsMs []float64
	var total []uint64
	for rows.Next() {
		var bounds []float64
		var counts []uint64
		if err := rows.Scan(&bounds, &counts); err != nil {
			return nil, nil, "", err
		}
		if len(counts) == 0 {
			continue
		}
		if total == nil {
			boundsMs = make([]float64, len(bounds))
			for i, b := range bounds {
				boundsMs[i] = b * toMs
			}
			total = make([]uint64, len(counts))
		}
		if len(counts) != len(total) {
			continue // differing bucket layouts — skip (rare)
		}
		for i, c := range counts {
			total[i] += c
		}
	}
	return boundsMs, total, unit, rows.Err()
}

// ServiceApdex computes Apdex from real latency buckets over the window.
//   satisfied: d ≤ T ; tolerating: T < d ≤ 4T ; frustrated: d > 4T.
// Bucket edges are interpolated at T and 4T. Returns (score, sampleCount, ok).
func (s *Store) ServiceApdex(ctx context.Context, tenantID, service string, tMs float64, from, to time.Time) (float64, uint64, bool, error) {
	bounds, counts, _, err := s.aggBuckets(ctx, tenantID, service, from, to)
	if err != nil {
		return 0, 0, false, err
	}
	if len(counts) == 0 {
		return 0, 0, false, nil
	}
	cumAt := func(x float64) float64 { return interpCumulative(bounds, counts, x) }
	total := 0.0
	for _, c := range counts {
		total += float64(c)
	}
	if total == 0 {
		return 0, 0, false, nil
	}
	satisfied := cumAt(tMs)
	tolerating := cumAt(4*tMs) - satisfied
	score := (satisfied + tolerating/2) / total
	return score, uint64(total), true, nil
}

// ServicePercentiles returns p50/p95/p99 in ms interpolated from buckets.
func (s *Store) ServicePercentiles(ctx context.Context, tenantID, service string, from, to time.Time) (p50, p95, p99 float64, ok bool, err error) {
	bounds, counts, _, err := s.aggBuckets(ctx, tenantID, service, from, to)
	if err != nil {
		return 0, 0, 0, false, err
	}
	if len(counts) == 0 {
		return 0, 0, 0, false, nil
	}
	return quantileFromBuckets(bounds, counts, 0.5),
		quantileFromBuckets(bounds, counts, 0.95),
		quantileFromBuckets(bounds, counts, 0.99),
		true, nil
}

// interpCumulative estimates how many samples fall at or below x, linearly
// interpolating within the bucket that contains x.
func interpCumulative(bounds []float64, counts []uint64, x float64) float64 {
	cum := 0.0
	lower := 0.0
	for i, c := range counts {
		var upper float64
		if i < len(bounds) {
			upper = bounds[i]
		} else {
			upper = lower // +Inf bucket: no interpolation
		}
		if i < len(bounds) && x >= upper {
			cum += float64(c)
			lower = upper
			continue
		}
		if i < len(bounds) && upper > lower {
			frac := (x - lower) / (upper - lower)
			if frac < 0 {
				frac = 0
			}
			if frac > 1 {
				frac = 1
			}
			cum += float64(c) * frac
		}
		break
	}
	return cum
}

// quantileFromBuckets returns the value (ms) at quantile q via linear
// interpolation across cumulative bucket counts.
func quantileFromBuckets(bounds []float64, counts []uint64, q float64) float64 {
	total := 0.0
	for _, c := range counts {
		total += float64(c)
	}
	if total == 0 {
		return 0
	}
	target := q * total
	cum := 0.0
	lower := 0.0
	for i, c := range counts {
		next := cum + float64(c)
		if next >= target {
			var upper float64
			if i < len(bounds) {
				upper = bounds[i]
			} else {
				return lower // in +Inf bucket
			}
			if c == 0 {
				return upper
			}
			frac := (target - cum) / float64(c)
			return lower + frac*(upper-lower)
		}
		cum = next
		if i < len(bounds) {
			lower = bounds[i]
		}
	}
	return lower
}
