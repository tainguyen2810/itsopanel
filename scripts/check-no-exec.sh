#!/usr/bin/env bash
# Chặn mọi cách chạy lệnh hệ thống:
#  - apps/api/app: exec, shell_exec, system, passthru, proc_open, popen, pcntl_exec, backtick,
#    Symfony Process, Laravel Process facade (CLAUDE.md §2).
#  - agent/: mock agent và mọi package không được dùng os/exec, syscall.Exec, "sh -c".
#    (Agent thật ở Phase 4 sẽ có allowlist binary cố định trong một package riêng, xem docs/planning.)
# Dùng: scripts/check-no-exec.sh [thư-mục-api-app] [thư-mục-agent]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="${1:-$ROOT/apps/api/app}"
AGENT_DIR="${2:-$ROOT/agent}"
fail=0

report() { # $1 = mô tả, stdin = kết quả grep
  local out; out="$(cat)"
  if [[ -n "$out" ]]; then
    echo "✗ $1:"; echo "$out" | sed 's/^/    /'; fail=1
  fi
}

if [[ -d "$API_DIR" ]]; then
  # Bỏ comment dòng (// và *) trước khi tìm để docblock không gây báo nhầm.
  report "hàm chạy lệnh trong $API_DIR" < <(grep -rniE --include='*.php' \
      '(^|[^A-Za-z0-9_>:$\\])\\?(exec|shell_exec|system|passthru|proc_open|popen|pcntl_exec)[[:space:]]*\(' "$API_DIR" \
      | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*|#)' || true)
  report "toán tử backtick trong $API_DIR" < <(grep -rnE --include='*.php' '`' "$API_DIR" \
      | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*|#)' || true)
  report "lớp Process trong $API_DIR" < <(grep -rnE --include='*.php' \
      'Symfony\\Component\\Process|Illuminate\\Support\\Facades\\Process|Illuminate\\Process\\' "$API_DIR" || true)
else
  echo "✗ không thấy $API_DIR"; fail=1
fi

if [[ -d "$AGENT_DIR" ]]; then
  report "chạy tiến trình trong $AGENT_DIR" < <(grep -rnE --include='*.go' \
      '"os/exec"|syscall\.(Exec|ForkExec)|"sh",[[:space:]]*"-c"|/bin/sh' "$AGENT_DIR" || true)
fi

if [[ $fail -ne 0 ]]; then
  echo "check-no-exec: THẤT BẠI"; exit 1
fi
echo "check-no-exec: OK (không có lệnh hệ thống trong ${API_DIR#$ROOT/} và ${AGENT_DIR#$ROOT/})"
