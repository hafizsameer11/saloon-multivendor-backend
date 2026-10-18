#!/bin/sh
set -e

cd /app

echo "→ Running Prisma migrations…"
npx prisma migrate deploy

echo "→ Starting API on 127.0.0.1:${PORT:-4000}…"
node dist/server.js &
API_PID=$!

# Wait until the API accepts connections (or fail fast)
i=0
until wget -qO- "http://127.0.0.1:${PORT:-4000}/api/v1/health" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "API failed to become healthy"
    kill "$API_PID" 2>/dev/null || true
    exit 1
  fi
  # If node already died, surface that
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "API process exited before becoming healthy"
    exit 1
  fi
  sleep 1
done

echo "→ Starting nginx on :80…"
nginx -g 'daemon off;' &
NGINX_PID=$!

term() {
  echo "Shutting down…"
  kill -TERM "$NGINX_PID" "$API_PID" 2>/dev/null || true
  wait "$NGINX_PID" "$API_PID" 2>/dev/null || true
  exit 0
}
trap term TERM INT

# Exit if either process dies
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do
  sleep 2
done

echo "A process exited unexpectedly"
term
