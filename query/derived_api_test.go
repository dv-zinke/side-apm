package query

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/heejune/apm/internal/storage"
)

type fakeDerived struct{ fakeReader }

func (fakeDerived) GetTraceSummary(_ context.Context, _, traceID string) (storage.TraceSummaryRow, error) {
	return storage.TraceSummaryRow{TraceID: traceID, EntryService: "SvcA", TransactionName: "/p",
		DurationMs: 200, SpanCount: 3, SqlCount: 1, HttpCallCount: 1, SqlTimeMs: 30, HttpCallTimeMs: 50}, nil
}
func (fakeDerived) ListServices(_ context.Context, _ string) ([]string, error) {
	return []string{"SvcA", "SvcB"}, nil
}
func (fakeDerived) GetServiceRED(_ context.Context, _, _ string, _, _ time.Time) ([]storage.REDPoint, error) {
	return []storage.REDPoint{{RequestCount: 2, ErrorCount: 1, P95Ms: 300}}, nil
}

func TestSummaryEndpoint(t *testing.T) {
	srv := httptest.NewServer(Router(fakeDerived{}))
	defer srv.Close()
	resp, _ := http.Get(srv.URL + "/api/v1/transactions/abc/summary")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var d TraceSummaryDTO
	json.NewDecoder(resp.Body).Decode(&d)
	if d.EntryService != "SvcA" || d.SqlCount != 1 || d.DurationMs != 200 {
		t.Fatalf("dto %+v", d)
	}
}

func TestServicesAndREDEndpoints(t *testing.T) {
	srv := httptest.NewServer(Router(fakeDerived{}))
	defer srv.Close()
	r1, _ := http.Get(srv.URL + "/api/v1/services")
	var svcs []string
	json.NewDecoder(r1.Body).Decode(&svcs)
	if len(svcs) != 2 || svcs[0] != "SvcA" {
		t.Fatalf("services %v", svcs)
	}
	r2, _ := http.Get(srv.URL + "/api/v1/services/SvcA/red?from=2020-01-01T00:00:00Z&to=2030-01-01T00:00:00Z")
	var pts []REDPointDTO
	json.NewDecoder(r2.Body).Decode(&pts)
	if len(pts) != 1 || pts[0].RequestCount != 2 {
		t.Fatalf("red %+v", pts)
	}
}
