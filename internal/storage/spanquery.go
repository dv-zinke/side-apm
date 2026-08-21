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

// ── Aggregation (facets) — the `... | stats <aggs> by <fields>` pipe ─────────
// Turns the query language from a filtered span list into a real analytics
// query (like NRQL FACET / Datadog "group by"). Same safety model: agg funcs
// and group fields are whitelisted, filter values stay bound params.

type FacetRow struct {
	Key    string    // group values joined by " · "
	Values []float64 // one per requested agg, aligned to Aggs
}

type FacetResult struct {
	Fields    []string // group-by fields (display)
	Aggs      []string // agg canonical names (count|errors|avg|p50|p95|p99|max|min)
	AggLabels []string // human labels aligned to Aggs
	Rows      []FacetRow
}

type SpanQueryResult struct {
	Kind  string // "spans" | "facets"
	Spans []SpanQueryRow
	Facet FacetResult
}

var aggFuncs = map[string]struct{ expr, label string }{
	"count":  {"toFloat64(count())", "건수"},
	"errors": {"toFloat64(countIf(status_code = 'ERROR'))", "에러"},
	"avg":    {"avg(duration_ns) / 1e6", "평균 ms"},
	"p50":    {"quantile(0.5)(duration_ns) / 1e6", "p50 ms"},
	"p95":    {"quantile(0.95)(duration_ns) / 1e6", "p95 ms"},
	"p99":    {"quantile(0.99)(duration_ns) / 1e6", "p99 ms"},
	"max":    {"max(duration_ns) / 1e6", "최대 ms"},
	"min":    {"min(duration_ns) / 1e6", "최소 ms"},
}

// groupColumn maps a group-by field to a display-safe SQL expression.
func groupColumn(field string) (string, error) {
	if c, ok := stringCols[field]; ok {
		return "toString(" + c + ")", nil
	}
	switch field {
	case "status":
		return "toString(status_code)", nil
	case "httpstatus":
		return "toString(http_status_code)", nil
	}
	switch {
	case strings.HasPrefix(field, "attr."):
		key := field[len("attr."):]
		if !attrKeyRe.MatchString(key) {
			return "", qerr("잘못된 속성 키: %q", key)
		}
		return "span_attrs['" + key + "']", nil
	case strings.HasPrefix(field, "res."):
		key := field[len("res."):]
		if !attrKeyRe.MatchString(key) {
			return "", qerr("잘못된 속성 키: %q", key)
		}
		return "resource_attrs['" + key + "']", nil
	}
	return "", qerr("그룹화할 수 없는 필드: %q", field)
}

// parseStats compiles `stats <agg>[, <agg>] by <field>[, <field>]`.
func parseStats(clause string) (groupExprs, aggExprs []string, res FacetResult, err error) {
	f := strings.Fields(clause)
	if len(f) == 0 || !strings.EqualFold(f[0], "stats") {
		return nil, nil, res, qerr("집계는 `| stats <함수> by <필드>` 형식이에요")
	}
	// split tokens after "stats" into aggs (before "by") and fields (after).
	var aggToks, fieldToks []string
	seenBy := false
	for _, t := range f[1:] {
		t = strings.Trim(t, ",")
		if t == "" {
			continue
		}
		if strings.EqualFold(t, "by") {
			seenBy = true
			continue
		}
		if seenBy {
			fieldToks = append(fieldToks, t)
		} else {
			aggToks = append(aggToks, t)
		}
	}
	if len(aggToks) == 0 {
		return nil, nil, res, qerr("집계 함수를 하나 이상 적어주세요 (count·errors·avg·p95·max…)")
	}
	if len(fieldToks) == 0 {
		return nil, nil, res, qerr("`by` 뒤에 그룹화할 필드를 적어주세요")
	}
	if len(aggToks) > 4 || len(fieldToks) > 2 {
		return nil, nil, res, qerr("집계는 함수 4개·필드 2개까지 가능해요")
	}
	for _, a := range aggToks {
		fn, ok := aggFuncs[strings.ToLower(a)]
		if !ok {
			return nil, nil, res, qerr("알 수 없는 집계 함수: %q", a)
		}
		aggExprs = append(aggExprs, fn.expr)
		res.Aggs = append(res.Aggs, strings.ToLower(a))
		res.AggLabels = append(res.AggLabels, fn.label)
	}
	for _, fld := range fieldToks {
		col, e := groupColumn(fld)
		if e != nil {
			return nil, nil, res, e
		}
		groupExprs = append(groupExprs, col)
		res.Fields = append(res.Fields, fld)
	}
	return groupExprs, aggExprs, res, nil
}

// RunSpanQuery runs the DSL: a plain filter returns spans; a filter with a
// `| stats …` pipe returns facet aggregations.
func (s *Store) RunSpanQuery(ctx context.Context, tenantID, dsl string, from, to time.Time, limit int) (SpanQueryResult, error) {
	filterPart, statsPart, hasStats := strings.Cut(dsl, "|")
	// Allow a leading `stats …` with no pipe (implicit empty filter).
	if !hasStats && strings.HasPrefix(strings.ToLower(strings.TrimSpace(dsl)), "stats ") {
		filterPart, statsPart, hasStats = "", dsl, true
	}
	where, wargs, err := buildSpanWhere(strings.TrimSpace(filterPart))
	if err != nil {
		return SpanQueryResult{}, err
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	if !hasStats {
		spans, err := s.querySpanList(ctx, tenantID, where, wargs, from, to, limit)
		return SpanQueryResult{Kind: "spans", Spans: spans}, err
	}
	facet, err := s.querySpanFacets(ctx, tenantID, where, wargs, strings.TrimSpace(statsPart), from, to)
	return SpanQueryResult{Kind: "facets", Facet: facet}, err
}

func (s *Store) querySpanList(ctx context.Context, tenantID, where string, wargs []any, from, to time.Time, limit int) ([]SpanQueryRow, error) {
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

func (s *Store) querySpanFacets(ctx context.Context, tenantID, where string, wargs []any, statsPart string, from, to time.Time) (FacetResult, error) {
	groupExprs, aggExprs, res, err := parseStats(statsPart)
	if err != nil {
		return res, err
	}
	sel := make([]string, 0, len(groupExprs)+len(aggExprs))
	for i, g := range groupExprs {
		sel = append(sel, fmt.Sprintf("%s AS g%d", g, i))
	}
	for i, a := range aggExprs {
		sel = append(sel, fmt.Sprintf("%s AS a%d", a, i))
	}
	groupBy := make([]string, len(groupExprs))
	for i := range groupExprs {
		groupBy[i] = fmt.Sprintf("g%d", i)
	}
	q := fmt.Sprintf(`
SELECT %s
FROM apm.spans
WHERE tenant_id = ? AND start_time >= ? AND start_time <= ? AND %s
GROUP BY %s
ORDER BY a0 DESC
LIMIT 200
SETTINGS max_execution_time = 15`, strings.Join(sel, ", "), where, strings.Join(groupBy, ", "))
	args := append([]any{tenantID, from, to}, wargs...)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return res, err
	}
	defer rows.Close()
	nG, nA := len(groupExprs), len(aggExprs)
	for rows.Next() {
		gvals := make([]string, nG)
		avals := make([]float64, nA)
		dest := make([]any, nG+nA)
		for i := range gvals {
			dest[i] = &gvals[i]
		}
		for i := range avals {
			dest[nG+i] = &avals[i]
		}
		if err := rows.Scan(dest...); err != nil {
			return res, err
		}
		key := strings.Join(gvals, " · ")
		if key == "" {
			key = "(빈 값)"
		}
		res.Rows = append(res.Rows, FacetRow{Key: key, Values: avals})
	}
	return res, rows.Err()
}

// IsQueryError reports whether err is a user-facing DSL syntax error (→ 400).
func IsQueryError(err error) bool {
	_, ok := err.(*QueryError)
	return ok
}
