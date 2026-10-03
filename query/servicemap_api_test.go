package query

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type fakeSM struct{ fakeDerived }

func (fakeSM) GetServiceMap(_ context.Context, _ string, _, _ time.Time) (storage.ServiceMap, error) {
	return storage.ServiceMap{
		Nodes: []storage.ServiceNode{{Name: "A", RequestCount: 5}},
		Edges: []storage.ServiceEdge{{From: "A", To: "B", CallCount: 3, AvgMs: 12.5}},
	}, nil
}
func (fakeSM) RecentRootTxns(_ context.Context, _ string, _ time.Time, _ int) ([]storage.LiveTxn, error) {
	return []storage.LiveTxn{{TraceID: "t1", Service: "A", DurationMs: 42, IsError: false}}, nil
}

func TestServiceMapEndpoint(t *testing.T) {
	srv := httptest.NewServer(Router(fakeSM{}))
	defer srv.Close()
	resp, _ := authGet(srv.URL + "/api/v1/servicemap")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var sm ServiceMapDTO
	json.NewDecoder(resp.Body).Decode(&sm)
	if len(sm.Nodes) != 1 || sm.Nodes[0].Name != "A" || len(sm.Edges) != 1 || sm.Edges[0].To != "B" {
		t.Fatalf("dto %+v", sm)
	}
}
