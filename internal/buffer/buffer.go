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

// Async decouples accept from write: Publish enqueues and returns immediately;
// a background worker batches spans and inserts them with retry/backoff. This
// absorbs traffic spikes and rides out transient ClickHouse hiccups without
// dropping data or blocking the caller. A bounded queue provides backpressure.
// (Cross-process durability — surviving a gateway crash — is the Kafka tier.)
type Async struct {
	store    Inserter
	ch       chan []otlp.Span
	batchMax int
	flush    time.Duration
	retries  int
}

type AsyncOpts struct {
	QueueDepth int           // number of in-flight publish batches buffered
	BatchMax   int           // flush once this many spans accumulate
	Flush      time.Duration // ...or after this interval
	Retries    int           // insert attempts before dropping a batch
}

func NewAsync(store Inserter, o AsyncOpts) *Async {
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
	a := &Async{
		store:    store,
		ch:       make(chan []otlp.Span, o.QueueDepth),
		batchMax: o.BatchMax,
		flush:    o.Flush,
		retries:  o.Retries,
	}
	go a.run()
	return a
}

func (a *Async) Publish(_ context.Context, spans []otlp.Span) error {
	if len(spans) == 0 {
		return nil
	}
	select {
	case a.ch <- spans:
		return nil
	default:
		return ErrQueueFull
	}
}

func (a *Async) run() {
	batch := make([]otlp.Span, 0, a.batchMax)
	ticker := time.NewTicker(a.flush)
	defer ticker.Stop()
	for {
		select {
		case spans := <-a.ch:
			batch = append(batch, spans...)
			if len(batch) >= a.batchMax {
				a.write(batch)
				batch = batch[:0]
			}
		case <-ticker.C:
			if len(batch) > 0 {
				a.write(batch)
				batch = batch[:0]
			}
		}
	}
}

func (a *Async) write(batch []otlp.Span) {
	backoff := 100 * time.Millisecond
	for attempt := 1; attempt <= a.retries; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := a.store.InsertSpans(ctx, batch)
		cancel()
		if err == nil {
			return
		}
		if attempt == a.retries {
			log.Printf("buffer: dropping %d spans after %d attempts: %v", len(batch), a.retries, err)
			return
		}
		time.Sleep(backoff)
		backoff *= 2
	}
}
