package storage

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Log search — the same safe restricted DSL as span queries, retargeted at
// apm.logs. Reuses the shared tokenizer/operators/QueryError from spanquery.go.
// A plain filter returns log rows; a `| stats … by …` pipe returns facets.
//
//   service = X  severity = ERROR  body ~ "timeout"  attr.k = v   (joined by AND)
//   ... | stats count[, errors] by service|severity|trace|attr.k

type LogQueryResult struct {
	Kind  string // "rows" | "facets"
	Rows  []LogRow
	Facet FacetResult
}

// Plain string columns (severity handled specially for case-insensitive match).
var logStringCols = map[string]string{
	"service": "service_name",
	"trace":   "trace_id",
	"span":    "span_id",
	"body":    "body",
}

func buildLogWhere(dsl string) (string, []any, error) {
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
		clause, cargs, err := buildLogPredicate(field, op, val)
		if err != nil {
			return "", nil, err
		}
		clauses = append(clauses, clause)
		args = append(args, cargs...)
	}
	return "(" + strings.Join(clauses, " AND ") + ")", args, nil
}

func buildLogPredicate(field, op, rawVal string) (string, []any, error) {
	val := unquote(rawVal)
	// severity: case-insensitive equality (ERROR == error).
	if field == "severity" {
		switch op {
		case "=":
			return "upper(severity) = upper(?)", []any{val}, nil
		case "!=":
			return "upper(severity) != upper(?)", []any{val}, nil
		default:
			return "", nil, qerr("severity에는 = 또는 != 만 쓸 수 있어요")
		}
	}
	var col string
	if strings.HasPrefix(field, "attr.") {
		key := field[len("attr."):]
		if !attrKeyRe.MatchString(key) {
			return "", nil, qerr("잘못된 속성 키: %q", key)
		}
		col = "attrs['" + key + "']"
	} else {
		c, ok := logStringCols[field]
		if !ok {
			return "", nil, qerr("알 수 없는 필드: %q (사용 가능: service·severity·body·trace·span·attr.*)", field)
		}
		col = c
	}
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

var logAggFuncs = map[string]struct{ expr, label string }{
	"count":  {"toFloat64(count())", "건수"},
	"errors": {"toFloat64(countIf(upper(severity) = 'ERROR'))", "에러"},
}

func logGroupColumn(field string) (string, error) {
	switch field {
	case "service":
		return "toString(service_name)", nil
	case "severity":
		return "toString(severity)", nil
	case "trace":
		return "trace_id", nil
	}
	if strings.HasPrefix(field, "attr.") {
		key := field[len("attr."):]
		if !attrKeyRe.MatchString(key) {
			return "", qerr("잘못된 속성 키: %q", key)
		}
		return "attrs['" + key + "']", nil
	}
	return "", qerr("그룹화할 수 없는 필드: %q", field)
}

func parseLogStats(clause string) (groupExprs, aggExprs []string, res FacetResult, err error) {
	f := strings.Fields(clause)
	if len(f) == 0 || !strings.EqualFold(f[0], "stats") {
		return nil, nil, res, qerr("집계는 `| stats <함수> by <필드>` 형식이에요")
	}
	var aggToks, fieldToks []string
	seenBy := false
	for _, t := range f[1:] {
		if t = strings.Trim(t, ","); t == "" {
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
		return nil, nil, res, qerr("집계 함수를 하나 이상 적어주세요 (count·errors)")
	}
	if len(fieldToks) == 0 {
		return nil, nil, res, qerr("`by` 뒤에 그룹화할 필드를 적어주세요")
	}
	if len(aggToks) > 2 || len(fieldToks) > 2 {
		return nil, nil, res, qerr("로그 집계는 함수 2개·필드 2개까지 가능해요")
	}
	for _, a := range aggToks {
		fn, ok := logAggFuncs[strings.ToLower(a)]
		if !ok {
			return nil, nil, res, qerr("알 수 없는 집계 함수: %q (count·errors)", a)
		}
		aggExprs = append(aggExprs, fn.expr)
		res.Aggs = append(res.Aggs, strings.ToLower(a))
		res.AggLabels = append(res.AggLabels, fn.label)
	}
	for _, fld := range fieldToks {
		col, e := logGroupColumn(fld)
		if e != nil {
			return nil, nil, res, e
		}
		groupExprs = append(groupExprs, col)
		res.Fields = append(res.Fields, fld)
	}
	return groupExprs, aggExprs, res, nil
}

func (s *Store) RunLogQuery(ctx context.Context, tenantID, dsl string, from, to time.Time, limit int) (LogQueryResult, error) {
	filterPart, statsPart, hasStats := strings.Cut(dsl, "|")
	if !hasStats && strings.HasPrefix(strings.ToLower(strings.TrimSpace(dsl)), "stats ") {
		filterPart, statsPart, hasStats = "", dsl, true
	}
	where, wargs, err := buildLogWhere(strings.TrimSpace(filterPart))
	if err != nil {
		return LogQueryResult{}, err
	}
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	if !hasStats {
		rows, err := s.queryLogList(ctx, tenantID, where, wargs, from, to, limit)
		return LogQueryResult{Kind: "rows", Rows: rows}, err
	}
	facet, err := s.queryLogFacets(ctx, tenantID, where, wargs, strings.TrimSpace(statsPart), from, to)
	return LogQueryResult{Kind: "facets", Facet: facet}, err
}

func (s *Store) queryLogList(ctx context.Context, tenantID, where string, wargs []any, from, to time.Time, limit int) ([]LogRow, error) {
	q := `
SELECT ts, service_name, severity, body, trace_id, span_id
FROM apm.logs
WHERE tenant_id = ? AND ts >= ? AND ts <= ? AND ` + where + `
ORDER BY ts DESC
LIMIT ?
SETTINGS max_execution_time = 15`
	args := append([]any{tenantID, from, to}, wargs...)
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanLogs(rows)
}

func (s *Store) queryLogFacets(ctx context.Context, tenantID, where string, wargs []any, statsPart string, from, to time.Time) (FacetResult, error) {
	groupExprs, aggExprs, res, err := parseLogStats(statsPart)
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
FROM apm.logs
WHERE tenant_id = ? AND ts >= ? AND ts <= ? AND %s
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
