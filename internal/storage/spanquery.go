package storage

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Trace/span query — a small, SAFE query language over apm.spans (like a
// restricted NRQL / Datadog trace query). The whole point is power without a raw
// SQL surface:
//   - field names are whitelisted → fixed column mapping
//   - attribute keys (attr.*, res.*) are regex-validated then inlined
//   - every VALUE is a bound parameter (never string-concatenated)
//   - the assembled query always carries a tenant filter, time window, LIMIT,
//     and a max_execution_time cap
//
// Grammar (predicates joined by AND):
//   query      := predicate ( "AND" predicate )*
//   predicate  := field op value
//   field      := service|name|route|method|db|kind|status|httpstatus|duration
//               | attr.<key> | res.<key>
//   op         := = | != | > | < | >= | <= | ~ (contains) | !~ (not contains)
//   value      := "quoted" | number | duration(1s,500ms,…) | error|ok

type SpanQueryRow struct {
	TraceID    string
	SpanID     string
	Service    string
	Name       string
	Status     string
	DurationNs uint64
	StartTime  time.Time
	HTTPStatus uint16
	HTTPRoute  string
}

// stringCol: whitelisted fields backed by a plain String/LowCardinality column.
var stringCols = map[string]string{
	"service": "service_name",
	"name":    "span_name",
	"route":   "http_route",
	"method":  "http_method",
	"db":      "db_system",
	"kind":    "span_kind",
}

var attrKeyRe = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
var tokenRe = regexp.MustCompile(`"[^"]*"|'[^']*'|>=|<=|!=|!~|[=<>~]|[^\s=<>~]+`)
var durRe = regexp.MustCompile(`^(\d+(?:\.\d+)?)(ns|us|ms|s|m)$`)

type QueryError struct{ msg string }

func (e *QueryError) Error() string { return e.msg }
func qerr(f string, a ...any) error { return &QueryError{fmt.Sprintf(f, a...)} }

// buildSpanWhere compiles the DSL into a parenthesized WHERE fragment plus its
// bound args. Returns a QueryError (→ 400) for user syntax mistakes.
func buildSpanWhere(dsl string) (string, []any, error) {
	dsl = strings.TrimSpace(dsl)
	if dsl == "" {
		return "1", nil, nil
	}
	toks := tokenRe.FindAllString(dsl, -1)
	var clauses []string
	var args []any
	i, first := 0, true
	for i < len(toks) {
		if !first {
			if !strings.EqualFold(toks[i], "AND") {
				return "", nil, qerr("`%s` 앞에는 AND가 필요해요", toks[i])
			}
			i++
		}
		if i+3 > len(toks) {
			return "", nil, qerr("조건이 끝나지 않았어요 (형식: 필드 연산자 값)")
		}
		field, op, val := toks[i], toks[i+1], toks[i+2]
		i += 3
		first = false
		clause, cargs, err := buildPredicate(field, op, val)
		if err != nil {
			return "", nil, err
		}
		clauses = append(clauses, clause)
		args = append(args, cargs...)
	}
	return "(" + strings.Join(clauses, " AND ") + ")", args, nil
}

func unquote(v string) string {
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
		return v[1 : len(v)-1]
	}
	return v
}

func buildPredicate(field, op, rawVal string) (string, []any, error) {
	val := unquote(rawVal)

	// duration: numeric column, value parsed to nanoseconds.
	if field == "duration" {
		ns, err := parseDuration(val)
		if err != nil {
			return "", nil, err
		}
		cmp, ok := numOp(op)
		if !ok {
			return "", nil, qerr("duration에는 = != > < >= <= 만 쓸 수 있어요")
		}
		return "duration_ns " + cmp + " ?", []any{ns}, nil
	}

	// status: error|ok → span status; a number → http status code.
	if field == "status" {
		if strings.EqualFold(val, "error") || strings.EqualFold(val, "ok") || strings.EqualFold(val, "unset") {
			eq, ok := eqOp(op)
			if !ok {
				return "", nil, qerr("status에는 = 또는 != 만 쓸 수 있어요")
			}
			return "status_code " + eq + " ?", []any{strings.ToUpper(val)}, nil
		}
		field = "httpstatus" // numeric fallthrough
	}

	// httpstatus: numeric http_status_code.
	if field == "httpstatus" {
		n, err := strconv.Atoi(val)
		if err != nil {
			return "", nil, qerr("httpstatus 값은 숫자여야 해요: %q", val)
		}
		cmp, ok := numOp(op)
		if !ok {
			return "", nil, qerr("httpstatus에는 = != > < >= <= 만 쓸 수 있어요")
		}
		return "http_status_code " + cmp + " ?", []any{uint16(n)}, nil
	}

	// map attributes: attr.<key> / res.<key>. Key is validated then inlined; the
	// value stays a bound parameter.
	var col string
	switch {
	case strings.HasPrefix(field, "attr."):
		key := field[len("attr."):]
		if !attrKeyRe.MatchString(key) {
			return "", nil, qerr("잘못된 속성 키: %q", key)
		}
		col = "span_attrs['" + key + "']"
	case strings.HasPrefix(field, "res."):
		key := field[len("res."):]
		if !attrKeyRe.MatchString(key) {
			return "", nil, qerr("잘못된 속성 키: %q", key)
		}
		col = "resource_attrs['" + key + "']"
	default:
		c, ok := stringCols[field]
		if !ok {
			return "", nil, qerr("알 수 없는 필드: %q", field)
		}
		col = c
	}

	// string comparison operators.
	switch op {
	case "=":
		return col + " = ?", []any{val}, nil
	case "!=":
		return col + " != ?", []any{val}, nil
	case "~":
		return "positionCaseInsensitive(" + col + ", ?) > 0", []any{val}, nil
	case "!~":
		return "positionCaseInsensitive(" + col + ", ?) = 0", []any{val}, nil
	default:
		return "", nil, qerr("문자열 필드에는 = != ~ !~ 만 쓸 수 있어요 (%s)", op)
	}
}

func numOp(op string) (string, bool) {
	switch op {
	case "=", "!=", ">", "<", ">=", "<=":
		return op, true
	}
	return "", false
}
func eqOp(op string) (string, bool) {
	if op == "=" || op == "!=" {
		return op, true
	}
	return "", false
}

func parseDuration(v string) (uint64, error) {
	m := durRe.FindStringSubmatch(strings.ToLower(v))
	if m == nil {
		return 0, qerr("duration 형식이 이상해요 (예: 1s, 500ms, 2m): %q", v)
	}
	f, _ := strconv.ParseFloat(m[1], 64)
	switch m[2] {
	case "ns":
		return uint64(f), nil
	case "us":
		return uint64(f * 1e3), nil
	case "ms":
		return uint64(f * 1e6), nil
	case "s":
		return uint64(f * 1e9), nil
	case "m":
		return uint64(f * 60e9), nil
	}
	return 0, qerr("알 수 없는 단위: %q", v)
}

// QuerySpans runs a compiled DSL query over apm.spans within the window.
func (s *Store) QuerySpans(ctx context.Context, tenantID, dsl string, from, to time.Time, limit int) ([]SpanQueryRow, error) {
	where, wargs, err := buildSpanWhere(dsl)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	q := `
SELECT trace_id, span_id, service_name, span_name, status_code, duration_ns, start_time, http_status_code, http_route
FROM apm.spans
WHERE tenant_id = ? AND start_time >= ? AND start_time <= ? AND ` + where + `
ORDER BY start_time DESC
LIMIT ?
SETTINGS max_execution_time = 15`
	args := append([]any{tenantID, from, to}, wargs...)
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SpanQueryRow
	for rows.Next() {
		var r SpanQueryRow
		if err := rows.Scan(&r.TraceID, &r.SpanID, &r.Service, &r.Name, &r.Status, &r.DurationNs, &r.StartTime, &r.HTTPStatus, &r.HTTPRoute); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// IsQueryError reports whether err is a user-facing DSL syntax error (→ 400).
func IsQueryError(err error) bool {
	_, ok := err.(*QueryError)
	return ok
}
