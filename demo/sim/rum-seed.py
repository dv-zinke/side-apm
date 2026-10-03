#!/usr/bin/env python3
# Seed the RUM pipeline with realistic browser sessions.
#   python3 demo/sim/rum-seed.py [endpoint] [sessions]
import json, random, sys, time, urllib.request

EP = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4318").rstrip("/") + "/v1/rum"
N = int(sys.argv[2]) if len(sys.argv) > 2 else 60

pages = ["/dashboard", "/trace", "/rum", "/alerts", "/db", "/servicemap"]
clicks = ["대시보드", "트레이스 분석", "RED 대시보드", "알림", "서비스맵", "규칙 추가",
          "다크 모드로 전환", "복사", "저장하기", "에러만", "규칙 만들기", "X-View", "연결하기"]
errors = ["TypeError: Cannot read properties of undefined (reading 'map')",
          "NetworkError: Failed to fetch",
          "Unhandled: request timeout after 10000ms",
          "RangeError: Maximum call stack size exceeded"]
resources = ["/api/v1/transactions", "/api/v1/servicemap", "/api/v1/live/recent",
             "/api/v1/services/GatewayService/red", "/api/v1/alerts", "/api/v1/db/queries"]
now = lambda: int(time.time() * 1000)

for _ in range(N):
    sid = "sess%d" % random.randint(1, 10 ** 9)
    page = random.choice(pages)
    ev = [{"type": "pageview", "ts": now(), "page": page}]
    for _ in range(random.randint(3, 14)):
        ev.append({"type": "click", "ts": now(), "target": random.choice(clicks)})
    for _ in range(random.randint(2, 7)):
        ev.append({"type": "resource", "ts": now(), "url": random.choice(resources),
                   "value": random.randint(15, 950), "status": random.choice([200, 200, 200, 304, 500])})
    ev.append({"type": "vital", "ts": now(), "metric": "LCP", "value": random.randint(700, 4300)})
    ev.append({"type": "vital", "ts": now(), "metric": "INP", "value": random.randint(20, 380)})
    ev.append({"type": "vital", "ts": now(), "metric": "CLS", "value": round(random.uniform(0, 0.25), 3)})
    if random.random() < 0.28:
        ev.append({"type": "error", "ts": now(), "message": random.choice(errors), "stack": "at App.tsx:42:11"})
    body = json.dumps({"sessionId": sid, "page": page, "ua": "Mozilla/5.0", "events": ev}).encode()
    req = urllib.request.Request(EP, data=body, headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req).read()

print("seeded %d RUM sessions -> %s" % (N, EP))
