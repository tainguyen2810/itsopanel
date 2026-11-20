#!/usr/bin/env bash
# make dev — chạy mock agent + Laravel API + Vite (web) cùng lúc; Ctrl+C dừng cả ba.
# Chỉ nghe trên 127.0.0.1 / unix socket. Không đụng cấu hình hệ thống.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ITSO_AGENT_SOCKET="${ITSO_AGENT_SOCKET:-/tmp/itso-mock-agent.sock}"
API_PORT="${API_PORT:-8000}"
export ITSO_AGENT_SOCKET
export ITSO_API_URL="http://127.0.0.1:${API_PORT}"

if [[ ! -d apps/api/vendor || ! -d apps/web/node_modules ]]; then
  echo "Chưa cài dependency — chạy: make setup"
  exit 1
fi

pids=()
cleanup() {
  trap - INT TERM EXIT
  for p in "${pids[@]}"; do
    pkill -TERM -P "$p" 2>/dev/null || true # con của artisan serve (php -S)
    kill -TERM "$p" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

prefix() {
  local tag="$1" line
  while IFS= read -r line; do printf '[%s] %s\n' "$tag" "$line"; done
}

# Build lại mock agent nếu mã nguồn đổi (nhanh nhờ cache của Go).
( cd agent && go build -o bin/itso-mock-agent ./cmd/itso-mock-agent )

# Dùng process substitution để $! là PID thật của từng dịch vụ (không phải của bộ lọc prefix).
agent/bin/itso-mock-agent -listen "unix:${ITSO_AGENT_SOCKET}" > >(prefix agent) 2>&1 &
pids+=($!)
( cd apps/api && exec php artisan serve --host=127.0.0.1 --port="$API_PORT" --no-reload ) > >(prefix api) 2>&1 &
pids+=($!)
( cd apps/web && exec node node_modules/vite/bin/vite.js ) > >(prefix web) 2>&1 &
pids+=($!)

cat <<MSG

  ITSO Panel dev
  Admin : http://127.0.0.1:5173/admin/
  Portal: http://127.0.0.1:5173/portal/
  API   : ${ITSO_API_URL}/api/v1/system/health
  Agent : unix:${ITSO_AGENT_SOCKET} (mock)
  Ctrl+C để dừng.

MSG

wait -n "${pids[@]}" || true
echo "Một tiến trình đã dừng — dừng các tiến trình còn lại."
