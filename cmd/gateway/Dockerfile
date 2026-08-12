FROM golang:1.26 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /gateway ./cmd/gateway
FROM gcr.io/distroless/static-debian12
COPY --from=build /gateway /gateway
EXPOSE 4318
ENTRYPOINT ["/gateway"]
