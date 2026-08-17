package query

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/heejune/apm/internal/otlp"
	"github.com/heejune/apm/internal/storage"
)

type fakeReader struct{}

func (fakeReader) ListTransactions(_ context.Context, tenant string, f storage.Filter) ([]storage.TransactionRow, error) {
	return []storage.TransactionRow{{
		TraceID: "aa11", ServiceName: "GatewayService", TransactionName: "GET /x",
		StatusCode: "OK", StartTime: time.Unix(0, 0).UTC(), DurationNs: 1424000000,
	}}, nil
}

func (fakeReader) GetTraceSpans(_ context.Context, tenant, traceID string) ([]otlp.Span, error) {
	return []otlp.Span{{
		TraceID: traceID, SpanID: "01", SpanName: "GET /x", SpanKind: "SERVER",
		DurationNs: 500000, // 0.5ms — tests sub-millisecond precision
	}}, nil
}

func (fakeReader) GetTraceSummary(_ context.Context, _, traceID string) (storage.TraceSummaryRow, error) {
	return storage.TraceSummaryRow{}, nil
}

func (fakeReader) ListServices(_ context.Context, _ string) ([]string, error) {
	return nil, nil
}

func (fakeReader) GetServiceRED(_ context.Context, _, _ string, _, _ time.Time) ([]storage.REDPoint, error) {
	return nil, nil
}

func (fakeReader) GetServiceMap(_ context.Context, _ string, _, _ time.Time) (storage.ServiceMap, error) {
	return storage.ServiceMap{}, nil
}

func (fakeReader) RecentRootTxns(_ context.Context, _ string, _ time.Time, _ int) ([]storage.LiveTxn, error) {
	return nil, nil
}

func (fakeReader) BackfillTxns(_ context.Context, _ string, _ time.Time, _ int) ([]storage.LiveTxn, error) {
	return nil, nil
}

func (fakeReader) ListMetricNames(_ context.Context, _, _ string) ([]string, error) {
	return nil, nil
}

func (fakeReader) GetServiceMetric(_ context.Context, _, _, _ string, _, _ time.Time) ([]storage.MetricPoint, error) {
	return nil, nil
}

func (fakeReader) GetTraceLogs(_ context.Context, _, _ string) ([]storage.LogRow, error) {
	return nil, nil
}

func (fakeReader) LogPatterns(_ context.Context, _, _ string, _, _ time.Time, _ int) ([]storage.LogPattern, error) {
	return nil, nil
}
func (fakeReader) ListLogs(_ context.Context, _ string, _ storage.LogFilter) ([]storage.LogRow, error) {
	return nil, nil
}

func (fakeReader) ListAlertRules(_ context.Context, _ string) ([]storage.AlertRule, error) {
	return nil, nil
}

func (fakeReader) UpsertAlertRule(_ context.Context, _ string, _ storage.AlertRule) error {
	return nil
}

func (fakeReader) DeleteAlertRule(_ context.Context, _, _ string) error { return nil }

func (fakeReader) ListAlerts(_ context.Context, _ string, _ int) ([]storage.Alert, error) {
	return nil, nil
}

func (fakeReader) ServiceApdex(_ context.Context, _, _ string, _ float64, _, _ time.Time) (float64, uint64, bool, error) {
	return 0, 0, false, nil
}

func (fakeReader) ServicePercentiles(_ context.Context, _, _ string, _, _ time.Time) (float64, float64, float64, bool, error) {
	return 0, 0, 0, false, nil
}

func (fakeReader) TopQueries(_ context.Context, _, _, _ string, _, _ time.Time, _ int) ([]storage.QueryStat, error) {
	return nil, nil
}
func (fakeReader) NPlusOne(_ context.Context, _ string, _, _ int, _, _ time.Time) ([]storage.NPlusOneStat, error) {
	return nil, nil
}

func (fakeReader) RumOverview(_ context.Context, _ string, _, _ time.Time) (storage.RumOverview, error) {
	return storage.RumOverview{}, nil
}
func (fakeReader) TopClicks(_ context.Context, _ string, _, _ time.Time, _ int) ([]storage.RumCount, error) {
	return nil, nil
}
func (fakeReader) TopErrors(_ context.Context, _ string, _, _ time.Time, _ int) ([]storage.RumCount, error) {
	return nil, nil
}
func (fakeReader) TopResources(_ context.Context, _ string, _, _ time.Time, _ int) ([]storage.RumCount, error) {
	return nil, nil
}
func (fakeReader) ListReplays(_ context.Context, _ string, _, _ time.Time, _ int) ([]storage.ReplayMeta, error) {
	return nil, nil
}
func (fakeReader) GetReplay(_ context.Context, _, _ string) (string, error) {
	return "", nil
}
func (fakeReader) ListContainers(_ context.Context, _ string, _, _ time.Time) ([]storage.ContainerStat, error) {
	return nil, nil
}
func (fakeReader) ContainerSeries(_ context.Context, _, _, _ string, _, _ time.Time) ([]storage.MetricPoint, error) {
	return nil, nil
}
func (fakeReader) LatestHost(_ context.Context, _ string) (storage.HostStat, bool, error) {
	return storage.HostStat{}, false, nil
}
func (fakeReader) ServiceAvailabilities(_ context.Context, _ string, _, _ time.Time) ([]storage.ServiceAvail, error) {
	return nil, nil
}
func (fakeReader) AllServicesRED(_ context.Context, _ string, _, _ time.Time) (map[string][]storage.REDPoint, error) {
	return nil, nil
}
func (fakeReader) ListMonitors(_ context.Context, _ string, _, _ time.Time) ([]storage.MonitorStatus, error) {
	return nil, nil
}
func (fakeReader) MonitorTimeline(_ context.Context, _, _ string, _, _ time.Time, _ int) ([]storage.UptimeBucket, error) {
	return nil, nil
}
func (fakeReader) InsertDeploy(_ context.Context, _ string, _ storage.Deploy) error { return nil }
func (fakeReader) ListDeploys(_ context.Context, _, _ string, _, _ time.Time, _ int) ([]storage.Deploy, error) {
	return nil, nil
}
func (fakeReader) AppOverview(_ context.Context, _ string, _, _ time.Time) (storage.AppOverview, error) {
	return storage.AppOverview{}, nil
}
func (fakeReader) AppVersions(_ context.Context, _ string, _, _ time.Time, _ int) ([]storage.AppVersionStat, error) {
	return nil, nil
}
func (fakeReader) TopScreens(_ context.Context, _ string, _, _ time.Time, _ int) ([]storage.AppGroup, error) {
	return nil, nil
}
func (fakeReader) TopCrashes(_ context.Context, _ string, _, _ time.Time, _ int) ([]storage.AppGroup, error) {
	return nil, nil
}
func (fakeReader) TopAppNetwork(_ context.Context, _ string, _, _ time.Time, _ int) ([]storage.AppGroup, error) {
	return nil, nil
}
func (fakeReader) CrashDetail(_ context.Context, _, _ string, _, _ time.Time) (storage.CrashDetail, error) {
	return storage.CrashDetail{}, nil
}
func (fakeReader) ListDashboards(_ context.Context, _ string) ([]storage.Dashboard, error) {
	return nil, nil
}
func (fakeReader) UpsertDashboard(_ context.Context, _ string, _ storage.Dashboard) error { return nil }
func (fakeReader) DeleteDashboard(_ context.Context, _, _ string) error                   { return nil }
func (fakeReader) Authenticate(_ context.Context, _, _ string) (storage.User, bool, error) {
	return storage.User{}, false, nil
}
func (fakeReader) ListProfiles(_ context.Context, _ string, _, _ time.Time, _ int) ([]storage.ProfileMeta, error) {
	return nil, nil
}
func (fakeReader) GetProfile(_ context.Context, _, _ string) (string, string, string, string, error) {
	return "", "", "", "", nil
}

func authGet(url string) (*http.Response, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", "Bearer "+signToken(Principal{Tenant: "default", User: "t", Role: "admin", Exp: time.Now().Add(time.Hour).Unix()}))
	return http.DefaultClient.Do(req)
}

func TestListTransactionsEndpoint(t *testing.T) {
	srv := httptest.NewServer(Router(fakeReader{}))
	defer srv.Close()

	resp, err := authGet(srv.URL + "/api/v1/transactions?limit=10")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var got []TransactionDTO
	json.NewDecoder(resp.Body).Decode(&got)
	if len(got) != 1 || got[0].TraceID != "aa11" || got[0].DurationMs != float64(1424) {
		t.Fatalf("dto = %+v", got)
	}
}

func TestTraceSpansEndpoint(t *testing.T) {
	srv := httptest.NewServer(Router(fakeReader{}))
	defer srv.Close()

	resp, err := authGet(srv.URL + "/api/v1/traces/aa11/spans")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []SpanDTO
	json.NewDecoder(resp.Body).Decode(&got)
	if len(got) != 1 || got[0].SpanID != "01" || got[0].DurationMs != 0.5 {
		t.Fatalf("dto = %+v", got)
	}
}
