package buffer

import (
	"context"
	"testing"

	"github.com/heejune/apm/internal/otlp"
)

type fakeInserter struct{ got []otlp.Span }

func (f *fakeInserter) InsertSpans(_ context.Context, spans []otlp.Span) error {
	f.got = append(f.got, spans...)
	return nil
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
