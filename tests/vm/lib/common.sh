# shellcheck shell=bash
# Hàm dùng chung cho bộ test VM (chạy bằng root trong VM Ubuntu 24.04 dùng một lần).
set -uo pipefail

VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT="${REPORT:-/root/itso-vm-report.md}"
ROWS=()
PASS=0
FAIL=0
SKIP=0

# row <mã> <test> <kỳ vọng> <PASS|FAIL|SKIP|WARN> <chi tiết>
row() {
  local detail="${5//|/\\|}"
  detail="${detail//$'\n'/ }"
  ROWS+=("| $1 | $2 | $3 | **$4** | ${detail:0:300} |")
  case "$4" in
    PASS) PASS=$((PASS + 1)) ;;
    FAIL) FAIL=$((FAIL + 1)) ;;
    *) SKIP=$((SKIP + 1)) ;;
  esac
  printf '[%s] %s — %s\n' "$4" "$1" "$2" >&2
}

# agent <op> <params JSON> [cờ agent_call.py] → JSON {"http","body"}
agent() {
  local op="$1" params="$2"
  shift 2
  python3 "$VM_DIR/lib/agent_call.py" "$@" "$op" "$params"
}

# jget <JSON> <biểu thức python trên biến d> → giá trị
jget() {
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); print($2)" "$1" 2>/dev/null
}

# as_acct <user> <slice> <lệnh...>: chạy lệnh dưới UID account, trong slice của account (như PHP-FPM/SSH).
as_acct() {
  local user="$1" slice="$2"
  shift 2
  systemd-run --quiet --wait --pipe --collect --uid="$user" --gid="$user" --slice="$slice" \
    -p WorkingDirectory="/home/$user" -- "$@"
}

write_report() {
  {
    echo "# Báo cáo test VM — ITSO Panel"
    echo
    echo "- Thời điểm: $(date -Is)"
    echo "- Máy: $(hostname) · $(. /etc/os-release && echo "$PRETTY_NAME") · kernel $(uname -r) · $(nproc) vCPU · $(free -m | awk '/Mem:/{print $2}') MB RAM"
    echo "- Kết quả: **$PASS PASS · $FAIL FAIL · $SKIP SKIP/WARN**"
    echo
    echo "| Mã | Test | Kỳ vọng | Kết quả | Chi tiết |"
    echo "|---|---|---|---|---|"
    printf '%s\n' "${ROWS[@]}"
  } >"$REPORT"
  echo "Đã ghi $REPORT" >&2
}
