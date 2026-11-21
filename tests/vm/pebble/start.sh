#!/usr/bin/env bash
# Chạy Pebble (ACME test CA của Let's Encrypt) cho kiểm thử cert.issue thật — CHỈ trên runner CI / VM dùng một lần.
# PEBBLE_VA_ALWAYS_VALID=1: bỏ bước xác minh HTTP-01 (runner không có DNS cho *.itso.test); luồng ACME của lego vẫn thật.
set -euo pipefail
IMAGE="${PEBBLE_IMAGE:-ghcr.io/letsencrypt/pebble:latest}"
CA_DST=/etc/itso/acme/pebble-ca.pem
if command -v docker >/dev/null 2>&1; then
  docker rm -f itso-pebble >/dev/null 2>&1 || true
  docker run -d --name itso-pebble --network host -e PEBBLE_VA_ALWAYS_VALID=1 -e PEBBLE_VA_NOSLEEP=1 "$IMAGE" >/dev/null
  CA_TMP=$(mktemp)
  docker cp itso-pebble:/test/certs/pebble.minica.pem "$CA_TMP" 2>/dev/null \
    || curl -fsSL https://raw.githubusercontent.com/letsencrypt/pebble/main/test/certs/pebble.minica.pem -o "$CA_TMP"
elif [ -n "${PEBBLE_SRC:-}" ]; then
  # Không có Docker: chạy pebble đã build từ mã nguồn (PEBBLE_SRC = thư mục repo letsencrypt/pebble).
  (cd "$PEBBLE_SRC" && PEBBLE_VA_ALWAYS_VALID=1 PEBBLE_VA_NOSLEEP=1 nohup "${PEBBLE_BIN:-pebble}" -config test/config/pebble-config.json \
    >/tmp/itso-pebble.log 2>&1 &)
  CA_TMP="$PEBBLE_SRC/test/certs/pebble.minica.pem"
else
  echo "Cần Docker hoặc PEBBLE_SRC" >&2
  exit 1
fi
for _ in $(seq 1 30); do
  if curl -fsS --cacert "$CA_TMP" https://localhost:14000/dir >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS --cacert "$CA_TMP" https://localhost:14000/dir >/dev/null
sudo install -d -m 0700 -o root -g root /etc/itso/acme
sudo install -m 0644 -o root -g root "$CA_TMP" "$CA_DST"
echo "Pebble sẵn sàng ở https://localhost:14000/dir, CA: $CA_DST"
