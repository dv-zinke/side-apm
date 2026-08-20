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
