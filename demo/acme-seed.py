#!/usr/bin/env python3
# Seeds a SECOND tenant ("acme") with continuous cross-service traffic so the
# multi-tenancy demo shows live data (health/RED/servicemap/alerts) for a tenant
# other than default. AcmeWeb → AcmeAPI → AcmeBilling, with AcmeAPI ~15% errors.
#   python3 demo/acme-seed.py [gateway] [tenant]
import base64, json, os, sys, time, urllib.request, random

GW = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4318") + "/v1/traces"
TENANT = sys.argv[2] if len(sys.argv) > 2 else "acme"

def sp(tid, sid, psid, name, dur, err=False):
    now = time.time_ns()
    s = {"traceId": tid, "spanId": sid, "name": name, "kind": 2,
         "startTimeUnixNano": str(now - dur), "endTimeUnixNano": str(now),
         "status": {"code": 2 if err else 0}}
    if psid:
        s["parentSpanId"] = psid
    return s

print(f"seeding tenant {TENANT} → {GW}")
while True:
    rs = {}
    for _ in range(25):
        tid = base64.b64encode(os.urandom(16)).decode()
        web = base64.b64encode(os.urandom(8)).decode()
        api = base64.b64encode(os.urandom(8)).decode()
        bil = base64.b64encode(os.urandom(8)).decode()
        rs.setdefault("AcmeWeb", []).append(sp(tid, web, None, "GET /checkout", random.randint(30, 200) * 1_000_000))
        rs.setdefault("AcmeAPI", []).append(sp(tid, api, web, "POST /pay", random.randint(40, 300) * 1_000_000, random.random() < 0.15))
        rs.setdefault("AcmeBilling", []).append(sp(tid, bil, api, "charge", random.randint(20, 150) * 1_000_000))
    resourceSpans = [{"resource": {"attributes": [{"key": "service.name", "value": {"stringValue": svc}}]},
                      "scopeSpans": [{"spans": spans}]} for svc, spans in rs.items()]
    data = json.dumps({"resourceSpans": resourceSpans}).encode()
    req = urllib.request.Request(GW, data=data, headers={"Content-Type": "application/json", "X-APM-Tenant": TENANT})
    try:
        urllib.request.urlopen(req).read()
    except Exception:
        pass
    time.sleep(2)
