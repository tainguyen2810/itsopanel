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
    # Staging upload: panel ghi chunk, agent sandbox đọc /var/lib/itso/uploads dưới gốc sandbox (ADR 0019 §5).
    ITSO_UPLOAD_DIR="${ITSO_UPLOAD_DIR:-$SBX/root/var/lib/itso/uploads}"
    export ITSO_AGENT_KEY_FILE ITSO_UPLOAD_DIR ;;
  mock)
    ITSO_AGENT_SOCKET="${ITSO_AGENT_SOCKET:-/tmp/itso-mock-agent.sock}" ;;
  *) echo "ITSO_DEV_AGENT phải là sandbox hoặc mock"; exit 1 ;;
esac
API_PORT="${API_PORT:-8000}"
GATEWAY_PORT="${GATEWAY_PORT:-7811}"
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
  ( cd agent && go build -o bin/itso-agent ./cmd/itso-agent && go build -o bin/itso-gateway ./cmd/itso-gateway )
  mkdir -p "$SBX/root" "$ITSO_UPLOAD_DIR"
  umask 077
  [[ -s "$ITSO_AGENT_KEY_FILE" ]] || od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$ITSO_AGENT_KEY_FILE"
  chmod 600 "$ITSO_AGENT_KEY_FILE"
  [[ -s "$SBX/policy.yaml" ]] || printf 'version: 1\n' > "$SBX/policy.yaml"
  # Phase 10: sandbox dùng Engine Docker giả (không có daemon thật) nên bật cờ docker để e2e chạy được op docker.*/compose.*.
  # Máy thật vẫn mặc định tắt, chỉ bật bằng `itso policy set docker on` (ADR 0039).
  grep -q '^docker:' "$SBX/policy.yaml" || printf 'docker: true\n' >> "$SBX/policy.yaml"
  chmod 600 "$SBX/policy.yaml"
  umask 022
  rm -f "$ITSO_AGENT_SOCKET"
  agent/bin/itso-agent --sandbox --root "$SBX/root" --listen "unix:${ITSO_AGENT_SOCKET}" \
    --key-file "$ITSO_AGENT_KEY_FILE" --policy "$SBX/policy.yaml" --audit-log "$SBX/audit.jsonl" \
    --allow-uid "$(id -u)" --stream-listen "unix:$SBX/agent-stream.sock" --stream-allow-uid "$(id -u)" > >(prefix agent) 2>&1 &
  pids+=($!)
  # Phase 9 (D-89): itso-relay + một agent "node" (gốc sandbox riêng) quay số ra relay qua mTLS loopback.
  # PKI dev nằm trong .dev/relay (không bao giờ /etc). Panel đăng ký node qua enroll (Prompt 9.4).
  if [[ "${ITSO_DEV_NODE:-1}" == 1 ]]; then
    ( cd agent && go build -o bin/itso-relay ./cmd/itso-relay )
    RLY="$ROOT/.dev/relay" NODE="$ROOT/.dev/node-sandbox"
    agent/bin/itso-relay dev-init --dir "$RLY" --hosts 127.0.0.1,localhost
    # CA dev cho op pki.sign_csr của agent local (ký CSR khi node join bằng token) + panel ghim CA trong lệnh join.
    ( umask 077; mkdir -p "$SBX/root/etc/itso/pki" && cp "$RLY/ca.pem" "$RLY/ca.key" "$SBX/root/etc/itso/pki/" )
    export ITSO_PKI_CA_FILE="$RLY/ca.pem" ITSO_RELAY_PUBLIC_URL="https://127.0.0.1:${RELAY_PORT:-28444}"
    mkdir -p "$NODE/root/etc/itso/node"
    [[ -s "$NODE/uuid" ]] || python3 -c 'import uuid;print(uuid.uuid4())' > "$NODE/uuid"
    NODE_UUID="$(cat "$NODE/uuid")"
    [[ -s "$NODE/root/etc/itso/node/node.pem" ]] || agent/bin/itso-relay dev-issue --dir "$RLY" --uuid "$NODE_UUID" --out "$NODE/root/etc/itso/node" >/dev/null
    printf '{"role":"node","server_uuid":"%s","relay_url":"https://127.0.0.1:%s"}\n' "$NODE_UUID" "${RELAY_PORT:-28444}" > "$NODE/root/etc/itso/node.json"
    ( umask 077; [[ -s "$NODE/agent.key" ]] || od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$NODE/agent.key"
      [[ -s "$NODE/policy.yaml" ]] || printf 'version: 1\n' > "$NODE/policy.yaml" )
    export ITSO_RELAY_SOCKET="${ITSO_RELAY_SOCKET:-$RLY/relay.sock}" ITSO_RELAY_ENROLL_KEY_FILE="$RLY/enroll.key"
    agent/bin/itso-relay --sandbox --listen "127.0.0.1:${RELAY_PORT:-28444}" --socket "unix:$ITSO_RELAY_SOCKET" \
      --ca "$RLY/ca.pem" --cert "$RLY/relay.pem" --key "$RLY/relay.key" --state "$RLY/state.json" \
      --enroll-url "${ITSO_API_URL}/api/v1/internal/nodes:enroll" --relay-key-file "$RLY/enroll.key" > >(prefix relay) 2>&1 &
    pids+=($!)
    agent/bin/itso-agent --sandbox --mode node --root "$NODE/root" --listen "unix:$NODE/agent.sock" \
      --key-file "$NODE/agent.key" --policy "$NODE/policy.yaml" --audit-log "$NODE/audit.jsonl" \
      --allow-uid "$(id -u)" --stream-listen "" > >(prefix node) 2>&1 &
    pids+=($!)
  fi
  # Terminal USER (D-75): gateway WebSocket ↔ socket stream (shell giả trong sandbox); Vite proxy /gateway.
  agent/bin/itso-gateway --listen "127.0.0.1:${GATEWAY_PORT}" --agent-stream "unix:$SBX/agent-stream.sock" > >(prefix gateway) 2>&1 &
else
  ( cd agent && go build -o bin/itso-mock-agent ./cmd/itso-mock-agent )
  agent/bin/itso-mock-agent -listen "unix:${ITSO_AGENT_SOCKET}" > >(prefix agent) 2>&1 &
fi
pids+=($!)
( cd apps/api && exec php artisan serve --host=127.0.0.1 --port="$API_PORT" --no-reload ) > >(prefix api) 2>&1 &
pids+=($!)
# Worker chạy job nghiệp vụ (D-60: queue Redis theo QUEUE_CONNECTION trong apps/api/.env).
( cd apps/api && exec php artisan queue:work --queue=default,notifications --sleep=1 --tries=1 --timeout=900 ) > >(prefix queue) 2>&1 &
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
  Relay : https://127.0.0.1:${RELAY_PORT:-28444} + node sandbox .dev/node-sandbox (ITSO_DEV_NODE=0 để tắt)
  Gateway terminal: 127.0.0.1:${GATEWAY_PORT} (/gateway qua Vite; chỉ với agent sandbox)
  Queue : php artisan queue:work (job nghiệp vụ)
  Dữ liệu demo: cd apps/api && php artisan db:seed --class=DemoSeeder (docs/runbooks/phase-3-demo.md)
  Ctrl+C để dừng.

MSG

wait -n "${pids[@]}" || true
echo "Một tiến trình đã dừng — dừng các tiến trình còn lại."
