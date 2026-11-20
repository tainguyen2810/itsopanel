#!/usr/bin/env bash
# Chạy Pest với PostgreSQL + Redis thật (D-59; CI dùng service PG 16 + Redis 7).
# Chạy từ apps/api. Mặc định: 127.0.0.1:5432, DB itso_test, user itso (mật khẩu dev của docker-compose.dev.yml).
set -euo pipefail
export DB_CONNECTION=pgsql
export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-5432}"
export DB_DATABASE="${DB_DATABASE:-itso_test}"
export DB_USERNAME="${DB_USERNAME:-itso}"
export DB_PASSWORD="${DB_PASSWORD:-itso_dev_only}"  # giá trị dev công khai của docker-compose.dev.yml
export REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
if ! (exec 3<>"/dev/tcp/$DB_HOST/$DB_PORT") 2>/dev/null; then
  echo "✗ Pest cần PostgreSQL 16 ở $DB_HOST:$DB_PORT (D-59). Chạy: make services-up — hoặc đặt DB_HOST/DB_PORT." >&2
  exit 1
fi
exec php vendor/bin/pest
