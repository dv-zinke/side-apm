FROM golang:1.26 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /dockermon ./cmd/dockermon
FROM gcr.io/distroless/static-debian12
COPY --from=build /dockermon /dockermon
ENTRYPOINT ["/dockermon"]
