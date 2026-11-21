#!/usr/bin/env bash
# cert.issue / renew / inspect / remove THẬT qua handler agent (lego ↔ Pebble). Cần start.sh chạy trước, lego cài
# từ kho Ubuntu (`apt-get install lego`). CHỈ trên runner CI / VM dùng một lần: ghi /etc/itso và tạo user hệ thống.
set -euo pipefail
cd "$(dirname "$0")/../../../agent"
USER_NAME="${ITSO_PEBBLE_USER:-pebbleci}"
USER_UID="${ITSO_PEBBLE_UID:-20901}"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  sudo useradd -u "$USER_UID" -M -d "/home/$USER_NAME" -s /usr/sbin/nologin "$USER_NAME"
fi
test -x /usr/bin/lego || { echo "Thiếu /usr/bin/lego (apt-get install lego)" >&2; exit 1; }
sudo -E env "PATH=$PATH" "HOME=$HOME" "GOCACHE=$(go env GOCACHE)" "GOMODCACHE=$(go env GOMODCACHE)" \
  ITSO_PEBBLE_USER="$USER_NAME" ITSO_PEBBLE_UID="$USER_UID" \
  go test -tags pebble -run '^TestPebbleIssueReal$' -count=1 -v ./internal/ops
