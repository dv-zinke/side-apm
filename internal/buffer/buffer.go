package buffer

import (
	"context"

	"github.com/heejune/apm/internal/otlp"
)

type Port interface {
	Publish(ctx context.Context, spans []otlp.Span) error
}

type Inserter interface {
	InsertSpans(ctx context.Context, spans []otlp.Span) error
}

// Direct: Phase 1 — Kafka 없이 Writer(=Store) 인라인 호출.
type Direct struct{ Store Inserter }

func (d *Direct) Publish(ctx context.Context, spans []otlp.Span) error {
	return d.Store.InsertSpans(ctx, spans)
}
