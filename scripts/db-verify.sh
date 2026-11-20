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

# Migration Laravel theo Phase (database/tools/gen_migrations.py): áp lần lượt SQL của Phase 3 → 11
# vào database rỗng phải ra đúng schema của itso.sql + extras.sql; file migration đã commit khớp đặc tả.
echo "→ Migration theo Phase"
GEN="$ROOT/database/tools/gen_migrations.py"
MIG_OK=1
for f in "$ROOT"/apps/api/database/migrations/*_phase_*_schema.php; do
  [[ -e "$f" ]] || continue
  p=$(basename "$f" | sed -E 's/.*_phase_([0-9]+)_schema\.php/\1/')
  python3 "$GEN" "$p" --check | sed 's/^/  /' || MIG_OK=0
done
# psql/pg_dump tới database tên $1 (cùng server với DB kiểm chứng).
if [[ -n "${DB_VERIFY_URL:-}" ]]; then
  url_of() { sed -E "s#/[^/?]+(\?|$)#/$1\1#" <<<"$DB_VERIFY_URL"; }
  db_psql() { local d="$1"; shift; psql "$(url_of "$d")" -X -q -v ON_ERROR_STOP=1 "$@"; }
  db_dump() { pg_dump -s --no-owner "$(url_of "$1")"; }
  db_new() { psql "$DB_VERIFY_URL" -X -q -c "SET client_min_messages = warning" -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1"; }
else
  db_psql() { local d="$1"; shift; as_pg "$PG_BIN/psql" -h "$TMP" -U itso -d "$d" -X -q -v ON_ERROR_STOP=1 "$@"; }
  db_dump() { as_pg "$PG_BIN/pg_dump" -h "$TMP" -U itso -s --no-owner "$1"; }
  db_new() { as_pg "$PG_BIN/createdb" -h "$TMP" -U itso "$1"; }
fi
db_new itso_spec
db_new itso_phased
db_psql itso_spec <"$SCHEMA/itso.sql" >/dev/null
db_psql itso_spec <"$SCHEMA/extras.sql" >/dev/null
for p in 3 4 5 6 7 8 9 10 11; do
  if ! python3 "$GEN" "$p" --sql | db_psql itso_phased >/dev/null; then
    echo "  ✗ SQL Phase $p không áp được"; MIG_OK=0
  fi
done
clean_dump() { db_dump "$1" | grep -v -e '^--' -e '^\\restrict' -e '^\\unrestrict' | sed '/^$/d'; }
DIFF="$(mktemp)"
if diff <(clean_dump itso_spec) <(clean_dump itso_phased) >"$DIFF"; then
  echo "  ✓ Phase 3 → 11 áp lần lượt = itso.sql + extras.sql (pg_dump --schema-only giống hệt)"
else
  echo "  ✗ Schema theo Phase khác đặc tả:"; head -40 "$DIFF" | sed 's/^/      /'; MIG_OK=0
fi
rm -f "$DIFF"
[[ $FAILED -eq 0 && $TOTAL -gt 0 && $MIG_OK -eq 1 ]]
