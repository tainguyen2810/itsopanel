#!/usr/bin/env bash
# Kiểm mọi file sinh từ contracts/ còn khớp nguồn (không ghi gì vào repo).
# Lệch → exit 1 kèm lệnh sửa: make codegen
set -euo pipefail
cd "$(dirname "$0")/.."
PNPM="${PNPM:-corepack pnpm}"
fail=0

echo "== TS types từ OpenAPI"
(cd apps/web && $PNPM -s codegen:check) || fail=1

echo "== Go structs từ agent schemas"
python3 contracts/tools/gen_go_types.py --check || fail=1

echo "== Bản nhúng schema trong agent"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd agent && go run ./internal/contracts/sync ../contracts "$tmp/data")
if diff -r "$tmp/data" agent/internal/contracts/data >/dev/null; then
  echo "✓ agent/internal/contracts/data khớp contracts/"
else
  diff -rq "$tmp/data" agent/internal/contracts/data | sed 's/^/  /' >&2 || true
  echo "✗ agent/internal/contracts/data lệch với contracts/ — chạy: make codegen" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "codegen-check: LỖI — file sinh lệch với contracts. Chạy: make codegen" >&2
  exit 1
fi
echo "codegen-check: OK"
