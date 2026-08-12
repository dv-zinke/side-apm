# APM Node demo (OTel-instrumented)

One-line instrumentation via the OTel auto-instrumentations register hook.

## Install
    cd demo/node && npm install

## Run (gateway on :4318 must be up)
    OTEL_SERVICE_NAME=WebuyService \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
    OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
    OTEL_TRACES_EXPORTER=otlp \
    OTEL_METRICS_EXPORTER=none \
    OTEL_LOGS_EXPORTER=none \
    npm start

## Generate traffic
    curl http://localhost:3001/buy-request   # -> {"ordered":"in-stock"}
