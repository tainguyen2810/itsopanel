#!/usr/bin/env bash
# Chạy Pest với PostgreSQL + Redis thật thay cho SQLite trong bộ nhớ (CI dùng service PG 16 + Redis 7).
# Chạy từ apps/api. Mặc định: 127.0.0.1:5432, DB itso_test, user itso, không mật khẩu.
set -euo pipefail
export DB_CONNECTION=pgsql
export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-5432}"
export DB_DATABASE="${DB_DATABASE:-itso_test}"
export DB_USERNAME="${DB_USERNAME:-itso}"
export DB_PASSWORD="${DB_PASSWORD:-}"
export REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
exec php vendor/bin/pest
