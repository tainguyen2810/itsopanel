#!/usr/bin/env bash
# Kiểm chứng schema PostgreSQL 16: áp itso.sql + extras.sql vào cluster tạm, chạy database/tests/*.sql.
# - Có DB_VERIFY_URL: dùng database có sẵn (phải là DB rỗng, sẽ bị ghi đè schema public).
# - Không có: tạo cluster tạm bằng initdb (PG_BIN, mặc định /usr/lib/postgresql/16/bin), xóa khi xong.
# Thoát 0 khi mọi test PASS. In tổng số test.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$ROOT/database/schema"
TESTS="$ROOT/database/tests"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"

as_pg() {
  if [[ $(id -u) -eq 0 ]]; then runuser -u postgres -- "$@"; else "$@"; fi
}

TMP=""
cleanup() {
  if [[ -n "$TMP" && -d "$TMP" ]]; then
    as_pg "$PG_BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true
    rm -rf -- "$TMP"
  fi
}
trap cleanup EXIT

if [[ -n "${DB_VERIFY_URL:-}" ]]; then
  PSQL=(psql "$DB_VERIFY_URL")
else
  TMP="$(mktemp -d /tmp/itso-dbverify.XXXXXX)"
  chmod 755 "$TMP"
  [[ $(id -u) -eq 0 ]] && chown postgres "$TMP"
  as_pg "$PG_BIN/initdb" -D "$TMP/data" -U itso -A trust -E UTF8 --locale=C.UTF-8 >/dev/null
  as_pg "$PG_BIN/pg_ctl" -D "$TMP/data" -l "$TMP/pg.log" -w \
    -o "-k $TMP -c listen_addresses='' -c fsync=off" start >/dev/null
  as_pg "$PG_BIN/createdb" -h "$TMP" -U itso itso_verify
  PSQL=(as_pg "$PG_BIN/psql" -h "$TMP" -U itso -d itso_verify)
fi

run_sql() { "${PSQL[@]}" -X -q -v ON_ERROR_STOP=1 "$@"; }

echo "PostgreSQL: $(run_sql -tAc 'SHOW server_version')"
run_sql -tAc 'SELECT 1' >/dev/null
echo "→ Áp schema: itso.sql + extras.sql"
run_sql <"$SCHEMA/itso.sql" >/dev/null
run_sql <"$SCHEMA/extras.sql" >/dev/null
TABLES=$(run_sql -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE '%\_default' ESCAPE '\\'")
echo "  Số bảng: $TABLES"

echo "→ Chạy test SQL"
TOTAL=0
FAILED=0
for f in "$TESTS"/[0-9]*.sql; do
  name="$(basename "$f")"
  if out=$(run_sql <"$f" 2>&1); then
    n=$(grep -c 'PASS:' <<<"$out" || true)
    TOTAL=$((TOTAL + n))
    printf '  ✓ %-24s %3d test\n' "$name" "$n"
    if [[ "${VERBOSE:-0}" == 1 ]]; then { grep 'PASS:' <<<"$out" || true; } | sed 's/^.*PASS: /      - /'; fi
  else
    FAILED=$((FAILED + 1))
    printf '  ✗ %s\n' "$name"
    sed 's/^/      /' <<<"$out"
  fi
done

echo "Tổng: $TOTAL test PASS, $FAILED file lỗi"
[[ $FAILED -eq 0 && $TOTAL -gt 0 ]]
