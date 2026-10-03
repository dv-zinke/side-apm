package storage

import "testing"

func TestBuildSpanWhere(t *testing.T) {
	cases := []struct {
		dsl      string
		wantSQL  string
		wantArgs []any
	}{
		{"", "1", nil},
		{`service = "shop-web"`, "(service_name = ?)", []any{"shop-web"}},
		{`service="shop-web"`, "(service_name = ?)", []any{"shop-web"}}, // no spaces
		{`duration > 1s`, "(duration_ns > ?)", []any{uint64(1e9)}},
		{`duration>=500ms`, "(duration_ns >= ?)", []any{uint64(5e8)}},
		{`status = error`, "(status_code = ?)", []any{"ERROR"}},
		{`httpstatus >= 500`, "(http_status_code >= ?)", []any{uint16(500)}},
		{`status = 404`, "(http_status_code = ?)", []any{uint16(404)}}, // numeric status → http
		{`route ~ "/cart"`, "(positionCaseInsensitive(http_route, ?) > 0)", []any{"/cart"}},
		{`attr.http.host = "api.x"`, "(span_attrs['http.host'] = ?)", []any{"api.x"}},
		{`res.host.name = "web-1"`, "(resource_attrs['host.name'] = ?)", []any{"web-1"}},
		{
			`service = "shop-web" AND duration > 1s AND status = error`,
			"(service_name = ? AND duration_ns > ? AND status_code = ?)",
			[]any{"shop-web", uint64(1e9), "ERROR"},
		},
	}
	for _, c := range cases {
		sql, args, err := buildSpanWhere(c.dsl)
		if err != nil {
			t.Errorf("%q: unexpected error %v", c.dsl, err)
			continue
		}
		if sql != c.wantSQL {
			t.Errorf("%q: sql = %q, want %q", c.dsl, sql, c.wantSQL)
		}
		if len(args) != len(c.wantArgs) {
			t.Errorf("%q: args = %v, want %v", c.dsl, args, c.wantArgs)
			continue
		}
		for i := range args {
			if args[i] != c.wantArgs[i] {
				t.Errorf("%q: arg[%d] = %#v, want %#v", c.dsl, i, args[i], c.wantArgs[i])
			}
		}
	}
}

func TestParseStats(t *testing.T) {
	// valid
	ge, ae, res, err := parseStats("stats count, p95 by service")
	if err != nil {
		t.Fatalf("unexpected err %v", err)
	}
	if len(ge) != 1 || len(ae) != 2 || res.Fields[0] != "service" || res.Aggs[0] != "count" || res.Aggs[1] != "p95" {
		t.Fatalf("parse = %v %v %+v", ge, ae, res)
	}
	if ge[0] != "toString(service_name)" {
		t.Errorf("group expr = %q", ge[0])
	}
	// attr group + errors agg
	ge, _, res, err = parseStats("stats errors by attr.http.host")
	if err != nil || ge[0] != "span_attrs['http.host']" || res.Aggs[0] != "errors" {
		t.Fatalf("attr group = %v %+v (err %v)", ge, res, err)
	}
	// rejects
	for _, bad := range []string{"count by service", "stats bogus by service", "stats count by weird.field", "stats count by attr.bad key", "stats by service", "stats count"} {
		if _, _, _, err := parseStats(bad); err == nil {
			t.Errorf("%q: expected error", bad)
		}
	}
}

func TestBuildSpanWhereRejects(t *testing.T) {
	// Injection attempts and malformed input must all be QueryErrors, never SQL.
	bad := []string{
		`service = "x"; DROP TABLE apm.spans`,
		`bogusfield = 1`,
		`attr.http.host'] = '1' OR '1'='1`,
		`duration > abc`,
		`service`,          // incomplete
		`service =`,        // missing value
		`service = x extra`, // dangling token (no AND)
		`httpstatus > "no"`,
	}
	for _, dsl := range bad {
		if _, _, err := buildSpanWhere(dsl); err == nil {
			t.Errorf("%q: expected error, got none", dsl)
		} else if !IsQueryError(err) {
			t.Errorf("%q: expected QueryError, got %T", dsl, err)
		}
	}
}
