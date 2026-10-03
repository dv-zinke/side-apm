package storage

import "testing"

func TestBuildLogWhere(t *testing.T) {
	cases := []struct {
		dsl     string
		wantSQL string
	}{
		{"", "1"},
		{`service = "shop-web"`, "(service_name = ?)"},
		{`severity = error`, "(upper(severity) = upper(?))"},
		{`body ~ "timeout"`, "(positionCaseInsensitive(body, ?) > 0)"},
		{`attr.k = "v"`, "(attrs['k'] = ?)"},
		{`severity = ERROR AND body ~ "conn"`, "(upper(severity) = upper(?) AND positionCaseInsensitive(body, ?) > 0)"},
	}
	for _, c := range cases {
		sql, _, err := buildLogWhere(c.dsl)
		if err != nil {
			t.Errorf("%q: err %v", c.dsl, err)
		} else if sql != c.wantSQL {
			t.Errorf("%q: sql = %q, want %q", c.dsl, sql, c.wantSQL)
		}
	}
	// rejects (unknown field, injection, incomplete)
	for _, bad := range []string{`bogus = 1`, `severity > 3`, `service = "x"; DROP TABLE apm.logs`, `body`} {
		if _, _, err := buildLogWhere(bad); err == nil || !IsQueryError(err) {
			t.Errorf("%q: expected QueryError, got %v", bad, err)
		}
	}
}

func TestParseLogStats(t *testing.T) {
	ge, ae, res, err := parseLogStats("stats count, errors by service")
	if err != nil || len(ge) != 1 || len(ae) != 2 || res.Fields[0] != "service" {
		t.Fatalf("parse = %v %v %+v (err %v)", ge, ae, res, err)
	}
	for _, bad := range []string{"count by service", "stats avg by service", "stats count by bogus"} {
		if _, _, _, err := parseLogStats(bad); err == nil {
			t.Errorf("%q: expected error", bad)
		}
	}
}
