# 실행
docker compose -f deploy/docker-compose.yml up -d --build
# UI http://localhost:3000 · Query API http://localhost:8080 · OTLP http://localhost:4318

# 데모 트래픽 (demo/node)
cd demo/node && npm install
OTEL_SERVICE_NAME=WebuyService OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_TRACES_EXPORTER=otlp \
  OTEL_METRICS_EXPORTER=none OTEL_LOGS_EXPORTER=none npm start &
curl http://localhost:3001/buy-request

## 검증
curl -s 'http://localhost:8080/api/v1/transactions?limit=5'   # WebuyService 트랜잭션 JSON
# 브라우저에서 http://localhost:3000 열어 트랜잭션 리스트 → 행 클릭 → 트리뷰 확인
