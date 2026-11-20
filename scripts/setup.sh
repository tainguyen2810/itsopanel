#!/usr/bin/env bash
# make setup — cài dependency cho web, api, agent (môi trường DEV). Không đụng cấu hình hệ thống,
# không cần quyền root, không cần Docker (PostgreSQL/Redis là tùy chọn, xem docs/runbooks/dev-setup.md).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Thiếu '$1'. $2"; exit 1; }; }
ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }

step "Kiểm tra công cụ"
need node "Cài Node.js 22 LTS (xem docs/runbooks/dev-setup.md)."
need php "Cài PHP 8.3+ kèm pdo_pgsql, redis, curl, mbstring, xml, sqlite3."
need composer "Cài Composer 2."
need go "Cài Go 1.24+."
node_v="$(node -p 'process.versions.node')"
ver_ge "$node_v" 22.12.0 || { echo "Cần Node >= 22.12 (đang có $node_v)"; exit 1; }
php_v="$(php -r 'echo PHP_VERSION;')"
ver_ge "$php_v" 8.3.0 || { echo "Cần PHP >= 8.3 (đang có $php_v)"; exit 1; }
go_v="$(go env GOVERSION | sed 's/^go//')"
ver_ge "$go_v" 1.24.0 || { echo "Cần Go >= 1.24 (đang có $go_v)"; exit 1; }
for ext in pdo_pgsql curl mbstring dom pdo_sqlite; do
  php -m | grep -qix "$ext" || { echo "PHP thiếu extension $ext"; exit 1; }
done
php -m | grep -qix redis || echo "Cảnh báo: PHP thiếu extension redis (phpredis) — trang trạng thái sẽ báo Redis lỗi."
echo "node $node_v · php $php_v · go $go_v · $(composer --version 2>/dev/null | awk '{print $1, $3}')"

step "Web: pnpm install (apps/web)"
if command -v corepack >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
else
  need pnpm "Cài pnpm 10 (corepack enable hoặc npm i -g pnpm@10)."
  PNPM=(pnpm)
fi
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${PNPM[@]}" install --frozen-lockfile

step "API: composer install (apps/api)"
(
  cd apps/api
  composer install --no-interaction --no-progress
  if [[ ! -f .env ]]; then
    cp .env.example .env
    echo "Đã tạo apps/api/.env từ .env.example"
  fi
  grep -qE '^APP_KEY=.+' .env || php artisan key:generate --ansi
)

step "Agent: go build itso-mock-agent"
( cd agent && go mod download && go build -o bin/itso-mock-agent ./cmd/itso-mock-agent )

step "Xong"
echo "Chạy: make dev  →  http://127.0.0.1:5173/admin/  và  http://127.0.0.1:5173/portal/"
echo "PostgreSQL 16 + Redis 7 (tùy chọn): make services-up (Docker) hoặc cài trực tiếp theo docs/runbooks/dev-setup.md"
