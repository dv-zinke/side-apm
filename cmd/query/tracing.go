package main

import (
	"context"
	"log"
	"os"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// initTracing wires the query service to emit its own OTLP traces to the APM
// gateway — dogfooding: the console's real API traffic becomes real traces,
// RED, and service-map data (no simulator involved).
func initTracing(ctx context.Context, serviceName string) func() {
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		endpoint = "http://gateway:4318"
	}
	endpoint = strings.TrimPrefix(strings.TrimPrefix(endpoint, "http://"), "https://")

	exp, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpoint(endpoint),
		otlptracehttp.WithInsecure(),
	)
	if err != nil {
		log.Printf("tracing: exporter: %v (self-tracing disabled)", err)
		return func() {}
	}
	res, _ := resource.New(ctx, resource.WithAttributes(semconv.ServiceName(serviceName)))
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp, sdktrace.WithBatchTimeout(2*time.Second)),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	log.Printf("tracing: self-tracing as %q → %s", serviceName, endpoint)
	return func() { _ = tp.Shutdown(context.Background()) }
}
