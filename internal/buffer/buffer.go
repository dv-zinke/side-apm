package buffer

import (
	"context"
	"errors"
	"log"
	"time"

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

// ErrQueueFull is returned when the ingest buffer is saturated. The gateway
// maps it to 503 so the OTLP exporter retries (preserving at-least-once).
var ErrQueueFull = errors.New("ingest queue full")

type Opts struct {
	QueueDepth int           // number of in-flight publish batches buffered
	BatchMax   int           // flush once this many items accumulate
	Flush      time.Duration // ...or after this interval
	Retries    int           // insert attempts before dropping a batch
}

// Batcher decouples accept from write for any telemetry signal: Publish enqueues
// and returns immediately; a background worker batches items and writes them
// with retry/backoff. Absorbs spikes, rides out transient ClickHouse hiccups,
// and backpressures (ErrQueueFull → 503) instead of blocking or dropping.
// (Cross-process durability — surviving a gateway crash — is the Kafka tier.)
type Batcher[T any] struct {
	name     string
	write    func(context.Context, []T) error
	ch       chan []T
	batchMax int
	flush    time.Duration
	retries  int
}

func NewBatcher[T any](name string, write func(context.Context, []T) error, o Opts) *Batcher[T] {
	if o.QueueDepth <= 0 {
		o.QueueDepth = 1024
	}
	if o.BatchMax <= 0 {
		o.BatchMax = 2000
	}
	if o.Flush <= 0 {
		o.Flush = 500 * time.Millisecond
	}
	if o.Retries <= 0 {
		o.Retries = 3
	}
	b := &Batcher[T]{
		name: name, write: write,
		ch:       make(chan []T, o.QueueDepth),
		batchMax: o.BatchMax, flush: o.Flush, retries: o.Retries,
	}
	go b.run()
	return b
}

func (b *Batcher[T]) Publish(_ context.Context, items []T) error {
	if len(items) == 0 {
		return nil
	}
	select {
	case b.ch <- items:
		return nil
	default:
		return ErrQueueFull
	}
}

func (b *Batcher[T]) run() {
	batch := make([]T, 0, b.batchMax)
	ticker := time.NewTicker(b.flush)
	defer ticker.Stop()
	for {
		select {
		case items := <-b.ch:
			batch = append(batch, items...)
			if len(batch) >= b.batchMax {
				b.writeBatch(batch)
				batch = batch[:0]
			}
		case <-ticker.C:
			if len(batch) > 0 {
				b.writeBatch(batch)
				batch = batch[:0]
			}
		}
	}
}

func (b *Batcher[T]) writeBatch(batch []T) {
	backoff := 100 * time.Millisecond
	for attempt := 1; attempt <= b.retries; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := b.write(ctx, batch)
		cancel()
		if err == nil {
			return
		}
		if attempt == b.retries {
			log.Printf("buffer[%s]: dropping %d items after %d attempts: %v", b.name, len(batch), b.retries, err)
			return
		}
		time.Sleep(backoff)
		backoff *= 2
	}
}

// NewSpanBatcher is a typed convenience so the gateway keeps a buffer.Port.
func NewSpanBatcher(store Inserter, o Opts) *Batcher[otlp.Span] {
	return NewBatcher[otlp.Span]("spans", store.InsertSpans, o)
}
