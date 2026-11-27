#!/usr/bin/env bash
set -euo pipefail

: "${AYOTBI_DATABASE_URL:?PostgreSQL connection is required}"
: "${AYOTBI_ORIGIN:?HTTPS public origin is required}"
: "${AYOTBI_OIDC_ISSUER:?OIDC issuer is required}"
: "${AYOTBI_OIDC_CLIENT_ID:?OIDC client ID is required}"
: "${AYOTBI_OIDC_CLIENT_SECRET:?OIDC client secret is required}"
: "${AYOTBI_S3_BUCKET:?Private storage bucket is required}"
: "${AYOTBI_S3_REGION:?Storage region is required}"

pids=()
stop() {
    for pid in "${pids[@]}"; do
        kill -TERM "$pid" 2>/dev/null || true
    done
    wait || true
}
trap stop EXIT
trap 'exit 0' TERM INT

ayotbi-collaboration &
pids+=("$!")
ayotbi-collaboration media-worker &
pids+=("$!")
caddy run --config /app/Caddyfile --adapter caddyfile &
pids+=("$!")

# Render restarts this container if a required process exits.
wait -n "${pids[@]}"
exit 1
