FROM golang:1.26 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /query ./cmd/query
FROM gcr.io/distroless/static-debian12
COPY --from=build /query /query
EXPOSE 8080
ENTRYPOINT ["/query"]
