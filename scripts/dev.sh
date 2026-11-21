#!/usr/bin/env bash
# make dev — chạy agent + Laravel API + queue worker + Vite (web) cùng lúc; Ctrl+C dừng tất cả.
# Chỉ nghe trên 127.0.0.1 / unix socket. Không đụng cấu hình hệ thống.
# Phase 4.6: mặc định là agent thật ở chế độ sandbox (itso-agent --sandbox --root <thư mục riêng>): runner giả,
# không chạy lệnh hệ thống, có ký HMAC (D-66) như máy thật. ITSO_DEV_AGENT=mock để dùng lại mock agent cũ.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ITSO_DEV_AGENT="${ITSO_DEV_AGENT:-sandbox}"
SBX="${ITSO_SANDBOX_DIR:-$ROOT/.dev/agent-sandbox}"
case "$ITSO_DEV_AGENT" in
  sandbox)
    ITSO_AGENT_SOCKET="${ITSO_AGENT_SOCKET:-$SBX/agent.sock}"
    ITSO_AGENT_KEY_FILE="${ITSO_AGENT_KEY_FILE:-$SBX/agent.key}"
    export ITSO_AGENT_KEY_FILE ;;
  mock)
    ITSO_AGENT_SOCKET="${ITSO_AGENT_SOCKET:-/tmp/itso-mock-agent.sock}" ;;
  *) echo "ITSO_DEV_AGENT phải là sandbox hoặc mock"; exit 1 ;;
esac
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

# Dùng process substitution để $! là PID thật của từng dịch vụ (không phải của bộ lọc prefix).
if [[ "$ITSO_DEV_AGENT" == sandbox ]]; then
  # Build lại agent nếu mã nguồn đổi (nhanh nhờ cache của Go). Khóa HMAC + policy tạo một lần trong .dev/ (gitignore).
  ( cd agent && go build -o bin/itso-agent ./cmd/itso-agent )
  mkdir -p "$SBX/root"
  umask 077
  [[ -s "$ITSO_AGENT_KEY_FILE" ]] || od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$ITSO_AGENT_KEY_FILE"
  chmod 600 "$ITSO_AGENT_KEY_FILE"
  [[ -s "$SBX/policy.yaml" ]] || printf 'version: 1\n' > "$SBX/policy.yaml"
  chmod 600 "$SBX/policy.yaml"
  umask 022
  rm -f "$ITSO_AGENT_SOCKET"
  agent/bin/itso-agent --sandbox --root "$SBX/root" --listen "unix:${ITSO_AGENT_SOCKET}" \
    --key-file "$ITSO_AGENT_KEY_FILE" --policy "$SBX/policy.yaml" --audit-log "$SBX/audit.jsonl" \
    --allow-uid "$(id -u)" > >(prefix agent) 2>&1 &
else
  ( cd agent && go build -o bin/itso-mock-agent ./cmd/itso-mock-agent )
  agent/bin/itso-mock-agent -listen "unix:${ITSO_AGENT_SOCKET}" > >(prefix agent) 2>&1 &
fi
pids+=($!)
( cd apps/api && exec php artisan serve --host=127.0.0.1 --port="$API_PORT" --no-reload ) > >(prefix api) 2>&1 &
pids+=($!)
# Worker chạy job nghiệp vụ (D-60: queue Redis theo QUEUE_CONNECTION trong apps/api/.env).
( cd apps/api && exec php artisan queue:work --sleep=1 --tries=1 --timeout=900 ) > >(prefix queue) 2>&1 &
pids+=($!)
( cd apps/web && exec node node_modules/vite/bin/vite.js ) > >(prefix web) 2>&1 &
pids+=($!)

# Khi agent sẵn sàng: đọc dữ kiện server local và đồng bộ lại account (mock giữ trạng thái trong bộ nhớ;
# sandbox giữ trong $SBX/root nên reconcile chỉ bù phần thiếu).
(
  for _ in $(seq 1 50); do [[ -S "$ITSO_AGENT_SOCKET" ]] && break; sleep 0.2; done
  cd apps/api
  php artisan itso:server-local || true
  php artisan itso:reconcile || true
) > >(prefix setup) 2>&1 &

cat <<MSG

  ITSO Panel dev
  Admin : http://127.0.0.1:5173/admin/
  Portal: http://127.0.0.1:5173/portal/
  API   : ${ITSO_API_URL}/api/v1/system/health
  Agent : unix:${ITSO_AGENT_SOCKET} (${ITSO_DEV_AGENT}; ITSO_DEV_AGENT=mock để dùng mock agent)
  Queue : php artisan queue:work (job nghiệp vụ)
  Dữ liệu demo: cd apps/api && php artisan db:seed --class=DemoSeeder (docs/runbooks/phase-3-demo.md)
  Ctrl+C để dừng.

MSG

wait -n "${pids[@]}" || true
echo "Một tiến trình đã dừng — dừng các tiến trình còn lại."
