#!/usr/bin/env bash
# Kiểm build thường KHÔNG chứa API giả lập (MSW, dữ liệu demo), và build demo có đủ worker.
# Dùng sau `make build-web`; tự build demo vào apps/web/dist-demo.
set -euo pipefail
cd "$(dirname "$0")/../apps/web"

test -d dist || { echo "thiếu apps/web/dist: chạy make build-web trước"; exit 1; }
# Dấu hiệu chỉ có trong mã demo: tên worker, header demo, thư viện MSW, uuid dữ liệu mẫu kiểu kind 0xfe.
if grep -rlE 'mockServiceWorker|X-Demo-User|setupWorker|onUnhandledFrame|01938afe-' dist; then
  echo "✗ build thường chứa mã demo/MSW (các file ở trên)"
  exit 1
fi
test ! -e dist/mockServiceWorker.js || { echo "✗ dist có mockServiceWorker.js"; exit 1; }
echo "✓ build thường không chứa MSW"

node node_modules/vite/bin/vite.js build --mode demo --logLevel warn
test -f dist-demo/mockServiceWorker.js || { echo "✗ dist-demo thiếu mockServiceWorker.js"; exit 1; }
grep -rlq 'X-Demo-User' dist-demo/assets || { echo "✗ dist-demo thiếu API giả lập"; exit 1; }
echo "✓ build demo có worker và API giả lập (apps/web/dist-demo)"
