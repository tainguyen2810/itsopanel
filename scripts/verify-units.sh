#!/usr/bin/env bash
# Kiểm cú pháp unit systemd của panel (packaging/systemd) và drop-in slice mẫu của agent bằng
# `systemd-analyze verify` (chạy offline). verify trả 0 cả khi có cảnh báo, nên script đọc output:
# chỉ bỏ qua cảnh báo "binary chưa có" cho /opt/itso/current/bin/* (có sau khi cài release).
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v systemd-analyze >/dev/null; then
  echo "verify-units: thiếu systemd-analyze" >&2
  exit 1
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp packaging/systemd/* "$tmp/"
cp packaging/systemd/itso-worker@.service "$tmp/itso-worker@1.service"
cp packaging/systemd/itso-php@.service "$tmp/itso-php@8.3-lehoa.service"
g=agent/internal/ops/testdata/golden
cp "$g/itso-acct-20001.slice.limits.conf" "$tmp/itso-acct-20001.slice"
cp "$g/user-20001.slice.conf" "$tmp/user-20001.slice"
units=()
for f in "$tmp"/*; do
  case "$f" in *@.service) ;; *) units+=("$f") ;; esac
done
out=$(cd "$tmp" && systemd-analyze verify --man=no "${units[@]}" 2>&1 || true)
bad=$(printf '%s\n' "$out" | grep -v -E 'Command /opt/itso/current/bin/[a-z-]+ is not executable: No such file or directory' | grep -v '^$' || true)
if [ -n "$bad" ]; then
  printf '%s\n' "$bad"
  echo "verify-units: THẤT BẠI"
  exit 1
fi
echo "verify-units: OK (${#units[@]} unit)"
