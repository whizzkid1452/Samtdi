FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY services/collaboration/go.mod services/collaboration/go.sum ./
RUN go mod download
COPY services/collaboration/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ayotbi-collaboration ./cmd/ayotbi-collaboration

FROM caddy:2.10.2-alpine AS proxy

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/* && \
    useradd --system --create-home --home-dir /home/samtdi samtdi
WORKDIR /app
COPY --from=build /out/ayotbi-collaboration /usr/local/bin/ayotbi-collaboration
COPY --from=proxy /usr/bin/caddy /tmp/caddy-upstream
# Render runs without privileged-port capabilities. Install a fresh binary inode
# so the upstream image's file capabilities are not carried into the runtime.
RUN install -m 0755 /tmp/caddy-upstream /usr/local/bin/caddy && rm /tmp/caddy-upstream
COPY ops/render/Caddyfile /app/Caddyfile
COPY ops/render/start.sh /app/start.sh
ENV PORT=10000 AYOTBI_LISTEN=127.0.0.1:8080 GOMEMLIMIT=160MiB GOMAXPROCS=2
USER samtdi
# Verify the proxy is executable as the actual unprivileged runtime user.
RUN /usr/local/bin/caddy version
EXPOSE 10000
ENTRYPOINT ["bash", "/app/start.sh"]
