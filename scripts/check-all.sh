#!/usr/bin/env bash
# make check — chạy toàn bộ pipeline local (tương đương .github/workflows/ci.yml), in bảng kết quả.
# Exit ≠ 0 nếu có bước FAIL. Bước SKIP (thiếu công cụ/dịch vụ tùy chọn) được ghi rõ, không tính là PASS.
#
# Biến môi trường:
#   CHECK_FUZZTIME=30s     thời gian fuzz (CI: 30s)
#   CHECK_SKIP_E2E=1       bỏ Playwright (máy không có Chromium)
#   DB_HOST/DB_PORT/...    PostgreSQL cho bước Pest + PostgreSQL (xem scripts/pest-pg.sh)
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
LOG_DIR="${CHECK_LOG_DIR:-$ROOT/.cache/check}"
mkdir -p "$LOG_DIR"
export PATH="$PATH:/usr/local/go/bin:$(go env GOPATH 2>/dev/null || echo "$HOME/go")/bin"

names=() results=() times=() notes=()
fail=0

record() { names+=("$1"); results+=("$2"); times+=("$3"); notes+=("$4"); }

run() { # run <tên> <lệnh…>
  local name="$1"; shift
  local log="$LOG_DIR/$(printf '%s' "$name" | tr -c 'A-Za-z0-9_-' '_').log"
  local start=$SECONDS
  printf '→ %-28s ' "$name"
  if "$@" >"$log" 2>&1; then
    local d=$((SECONDS - start))
    echo "PASS (${d}s)"
    record "$name" PASS "${d}s" "$(summary "$name" "$log")"
  else
    local d=$((SECONDS - start))
    echo "FAIL (${d}s) — log: ${log#$ROOT/}"
    tail -n 15 "$log" | sed 's/^/    /'
    record "$name" FAIL "${d}s" "log: ${log#$ROOT/}"
    fail=1
  fi
}

skip() { printf '→ %-28s SKIP — %s\n' "$1" "$2"; record "$1" SKIP "-" "$2"; }

# Rút số liệu đáng chú ý từ log để in vào bảng.
summary() {
  local log="$2"
  case "$1" in
    test-web) grep -Eo 'Tests +[0-9]+ passed' "$log" | tail -1 | tr -s ' ' ;;
    test-api | test-api-pg) grep -Eo '"tests":[0-9]+' "$log" | tail -1 | sed 's/"tests":/tests /' ;;
    test-e2e) grep -Eo '[0-9]+ passed' "$log" | tail -1 ;;
    test-agent) echo "$(grep -c '^ok' "$log") gói ok" ;;
    test-fuzz) grep -Eo 'execs: [0-9]+' "$log" | tail -1 ;;
    db-verify) grep -Eio '[0-9]+/[0-9]+ test[^ ]*|[0-9]+ test[^ ]* PASS' "$log" | tail -1 ;;
    tokens-check) grep -Eo '[0-9]+/[0-9]+ cặp' "$log" | tail -1 ;;
    check-ci) grep -Eo '[0-9]+ job' "$log" | tail -1 ;;
    *) echo "" ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }
tcp_open() { (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null; }

dirty_before="$(git status --porcelain 2>/dev/null)"

echo "== ITSO Panel — make check ($(date '+%Y-%m-%d %H:%M'))"
run structure        make -s structure
run docs-check       make -s docs-check
run check-ci         python3 scripts/check-ci.py
if [[ -n "${DB_VERIFY_URL:-}" || -x "${PG_BIN:-/usr/lib/postgresql/16/bin}/initdb" ]]; then
  run db-verify      make -s db-verify
else
  skip db-verify     "không có PostgreSQL 16 (PG_BIN) hoặc DB_VERIFY_URL"
fi
run contracts-check  make -s contracts-check
run codegen-check    make -s codegen-check
run tokens-check     make -s tokens-check
run lint-web         make -s lint-web
run test-web         make -s test-web
run build-web        bash -c 'make -s build-web && test ! -e apps/web/dist/design'
run build-demo       make -s build-demo
if [[ "${CHECK_SKIP_E2E:-0}" == 1 ]]; then
  skip test-e2e      "CHECK_SKIP_E2E=1"
else
  run test-e2e       make -s test-e2e
fi
run lint-api         make -s lint-api
run test-api         make -s test-api   # PostgreSQL bắt buộc (D-59)
run no-exec          make -s no-exec
run lint-agent       make -s lint-agent
if have staticcheck; then
  run staticcheck    bash -c 'cd agent && staticcheck ./...'
else
  skip staticcheck   "chưa cài staticcheck (CI chạy bản 2025.1.1)"
fi
run test-agent       make -s test-agent
run test-fuzz        make -s test-fuzz FUZZTIME="${CHECK_FUZZTIME:-30s}"
run build-agent      make -s build-agent

# Kiểm tra không được làm bẩn repo (file sinh lệch, ảnh, cache chưa ignore).
dirty_after="$(git status --porcelain 2>/dev/null)"
if [[ "$dirty_after" == "$dirty_before" ]]; then
  record "git-clean" PASS "-" "không phát sinh thay đổi"
else
  record "git-clean" FAIL "-" "make check làm thay đổi file trong repo"
  diff <(echo "$dirty_before") <(echo "$dirty_after") | sed 's/^/    /'
  fail=1
fi

echo
echo "| # | Bước | Kết quả | Thời gian | Ghi chú |"
echo "|---|---|---|---|---|"
pass=0 skipped=0 failed=0
for i in "${!names[@]}"; do
  case "${results[$i]}" in PASS) pass=$((pass + 1)) ;; SKIP) skipped=$((skipped + 1)) ;; FAIL) failed=$((failed + 1)) ;; esac
  printf '| %d | %s | %s | %s | %s |\n' "$((i + 1))" "${names[$i]}" "${results[$i]}" "${times[$i]}" "${notes[$i]}"
done
echo
echo "Tổng: ${pass} PASS · ${skipped} SKIP · ${failed} FAIL · ${SECONDS}s"
exit "$fail"
