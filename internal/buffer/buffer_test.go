package buffer

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/heejune/apm/internal/otlp"
)

type fakeInserter struct {
	mu  sync.Mutex
	got []otlp.Span
}

func (f *fakeInserter) InsertSpans(_ context.Context, spans []otlp.Span) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, spans...)
	return nil
}

func (f *fakeInserter) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.got)
}

func TestDirectPublish(t *testing.T) {
	fi := &fakeInserter{}
	var p Port = &Direct{Store: fi}
	err := p.Publish(context.Background(), []otlp.Span{{TraceID: "aa"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(fi.got) != 1 || fi.got[0].TraceID != "aa" {
		t.Fatalf("insert not called correctly: %+v", fi.got)
	}
}

func TestAsyncBatchesAndFlushes(t *testing.T) {
	fi := &fakeInserter{}
	a := NewAsync(fi, AsyncOpts{QueueDepth: 16, BatchMax: 1000, Flush: 20 * time.Millisecond})
	for i := 0; i < 5; i++ {
		if err := a.Publish(context.Background(), []otlp.Span{{TraceID: "t"}}); err != nil {
			t.Fatalf("publish %d: %v", i, err)
		}
	}
	// flush is interval-driven; wait past it.
	deadline := time.Now().Add(time.Second)
	for fi.count() < 5 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := fi.count(); got != 5 {
		t.Fatalf("expected 5 spans flushed, got %d", got)
	}
}

// blockInserter blocks until released, so the queue can saturate.
type blockInserter struct{ release chan struct{} }

func (b *blockInserter) InsertSpans(_ context.Context, _ []otlp.Span) error {
	<-b.release
	return nil
}

func TestAsyncBackpressure(t *testing.T) {
	bi := &blockInserter{release: make(chan struct{})}
	a := NewAsync(bi, AsyncOpts{QueueDepth: 2, BatchMax: 1, Flush: time.Hour})
	// Fill the worker (stuck on first insert) + the 2-deep queue, then expect
	// ErrQueueFull once saturated.
	var full bool
	for i := 0; i < 50; i++ {
		if err := a.Publish(context.Background(), []otlp.Span{{TraceID: "x"}}); err == ErrQueueFull {
			full = true
			break
		}
		time.Sleep(time.Millisecond)
	}
	close(bi.release)
	if !full {
		t.Fatal("expected ErrQueueFull under saturation")
	}
}
