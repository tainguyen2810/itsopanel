#!/usr/bin/env bash
# Bộ test VM Phase 4 (chạy bằng root trong VM Ubuntu 24.04 SẠCH, dùng một lần — KHÔNG chạy trên máy thật).
#
#   sudo bash tests/vm/run-all.sh --release <thư mục release> [--release2 <thư mục bản mới hơn>] [--no-uninstall]
#
# Thứ tự: cài sạch (đo thời gian, ≤ 10 phút) → cài lần 2 (không thay đổi) → doctor → enforcement 07 §9 →
# agent từ chối op lạ/tham số sai/không ký → update → rollback (nếu có --release2) → uninstall giữ /home.
# Kết quả: bảng Markdown ở $REPORT (mặc định /root/itso-vm-report.md). Thoát 1 nếu có FAIL.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

REL="" REL2="" UNINSTALL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --release) REL="$2"; shift 2 ;;
    --release2) REL2="$2"; shift 2 ;;
    --no-uninstall) UNINSTALL=0; shift ;;
    --report) REPORT="$2"; shift 2 ;;
    *) echo "tham số lạ: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "cần root (VM test)" >&2; exit 2; }
[ -n "$REL" ] && [ -f "$REL/install.sh" ] || { echo "--release phải là thư mục có install.sh (make release)" >&2; exit 2; }
if [ -e /etc/itso ] && [ "${ITSO_VM_FORCE:-0}" != 1 ]; then
  echo "/etc/itso đã có: bộ test cần VM sạch (đặt ITSO_VM_FORCE=1 nếu cố ý chạy lại)" >&2
  exit 2
fi
trap write_report EXIT
export DEBIAN_FRONTEND=noninteractive

# V1 cài sạch ≤ 10 phút (2 vCPU / 2 GB).
t0=$(date +%s)
ITSO_RELEASE_DIR="$REL" bash "$REL/install.sh" --yes >/root/itso-install-1.log 2>&1
rc=$?
dt=$(($(date +%s) - t0))
if [ "$rc" -eq 0 ] && [ "$dt" -le 600 ]; then
  row V1 "Cài sạch từ release cục bộ" "thành công, ≤ 600 giây" PASS "${dt} giây"
else
  row V1 "Cài sạch từ release cục bộ" "thành công, ≤ 600 giây" FAIL "exit $rc sau ${dt} giây; xem /root/itso-install-1.log: $(tail -n 3 /root/itso-install-1.log)"
fi

# V2 cài lần 2: idempotent, không lỗi, không đổi khóa agent.
k1=$(sha256sum /etc/itso/agent.key 2>/dev/null | cut -c1-16)
t0=$(date +%s)
ITSO_RELEASE_DIR="$REL" bash "$REL/install.sh" --yes >/root/itso-install-2.log 2>&1
rc=$?
dt=$(($(date +%s) - t0))
k2=$(sha256sum /etc/itso/agent.key 2>/dev/null | cut -c1-16)
if [ "$rc" -eq 0 ] && [ "$k1" = "$k2" ] && [ -n "$k1" ]; then
  row V2 "Chạy installer lần 2" "không lỗi, giữ khóa agent" PASS "${dt} giây, agent.key không đổi"
else
  row V2 "Chạy installer lần 2" "không lỗi, giữ khóa agent" FAIL "exit $rc, key $k1 → $k2"
fi

# V3 doctor + dịch vụ.
out=$(itso doctor 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then
  row V3 "itso doctor" "không FAIL" PASS "$(grep -c PASS <<<"$out") mục PASS"
else
  row V3 "itso doctor" "không FAIL" FAIL "$(grep FAIL <<<"$out" | head -3)"
fi
units=$(systemctl is-active itso-agent itso-web itso-redis itso-worker@1 2>&1 | tr '\n' ' ')
if ! grep -qv '^active$' <(systemctl is-active itso-agent itso-web itso-redis itso-worker@1); then
  row V4 "Dịch vụ panel chạy" "active" PASS "$units"
else
  row V4 "Dịch vụ panel chạy" "active" FAIL "$units"
fi
code=$(curl -ks -o /dev/null -w '%{http_code}' "https://127.0.0.1:$(sed -n 's/^ITSO_PANEL_PORT=//p' /etc/itso/itso.env)/api/v1/system/health")
[ "$code" = 200 ] && row V5 "HTTPS /api/v1/system/health" "200" PASS "200" || row V5 "HTTPS /api/v1/system/health" "200" FAIL "HTTP $code"

# Cài recipe stress-ng cho E1 (qua agent thật).
r=$(agent software.install '{"recipe":"stress-ng"}' --timeout 600)
[ "$(jget "$r" 'd["body"]["ok"]')" = True ] && row V6 "software.install stress-ng qua agent" "installed" PASS "$(jget "$r" 'd["body"]["data"]')" \
  || row V6 "software.install stress-ng qua agent" "installed" FAIL "$(jget "$r" 'd["body"]["error"]')"

# E0–E8 enforcement 07 §9.
ENF_STANDALONE=0 source "$VM_DIR/enforcement.sh"

# A1–A4 agent từ chối.
expect_err() { # <mã> <mô tả> <mã lỗi mong đợi> <op> <params> [cờ]
  local id="$1" what="$2" want="$3" op="$4" params="$5"
  shift 5
  local r got
  r=$(agent "$op" "$params" "$@")
  got=$(jget "$r" 'd["body"]["error"]["code"] if d["body"] else "http "+str(d["http"])')
  [ "$got" = "$want" ] && row "$id" "$what" "$want" PASS "$got" || row "$id" "$what" "$want" FAIL "$r"
}
expect_err A1 "Op không có trong registry (system.exec)" unknown_op system.exec '{"cmd":"id"}'
expect_err A2 "Tham số sai (username ../root)" invalid_params account.ensure \
  '{"account":{"username":"../root","uid":20009},"home_path":"/home/x","shell":"/bin/bash","limits":{"disk_mb":1,"inode_limit":1,"cpu_percent":1,"ram_mb":64,"tasks_max":16,"io_weight":1,"io_read_bps":null,"io_write_bps":null}}'
expect_err A3 "Không ký HMAC" unauthorized_caller system.ping '{}' --no-sign
expect_err A4 "Ký sai khóa" unauthorized_caller system.ping '{}' --bad-sign
out=$(setpriv --reuid=nobody --regid=nogroup --clear-groups python3 "$VM_DIR/lib/agent_call.py" --no-sign system.ping '{}' 2>&1)
if grep -q '"http": 0' <<<"$out" || grep -q unauthorized_caller <<<"$out"; then
  row A5 "UID không được phép (nobody) gọi socket" "bị từ chối" PASS "$(cut -c1-160 <<<"$out")"
else
  row A5 "UID không được phép (nobody) gọi socket" "bị từ chối" FAIL "$out"
fi

# U1 update → rollback.
if [ -n "$REL2" ]; then
  v1=$(itso version | sed -n 's/.*release đang chạy: \(.*\))/\1/p')
  itso update --release-dir "$REL2" >/root/itso-update.log 2>&1
  rc1=$?
  v2=$(itso version | sed -n 's/.*release đang chạy: \(.*\))/\1/p')
  itso rollback >>/root/itso-update.log 2>&1
  rc2=$?
  v3=$(itso version | sed -n 's/.*release đang chạy: \(.*\))/\1/p')
  if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$v2" != "$v1" ] && [ "$v3" = "$v1" ]; then
    row U1 "update → rollback" "lên bản mới rồi về bản cũ" PASS "$v1 → $v2 → $v3"
  else
    row U1 "update → rollback" "lên bản mới rồi về bản cũ" FAIL "exit $rc1/$rc2, $v1 → $v2 → $v3 (xem /root/itso-update.log)"
  fi
else
  row U1 "update → rollback" "lên bản mới rồi về bản cũ" SKIP "cần --release2 (bản release thứ hai)"
fi

# U2 uninstall giữ /home (chạy cuối).
if [ "$UNINSTALL" = 1 ]; then
  itso uninstall >/root/itso-uninstall.log 2>&1
  rc=$?
  kept=$(test -d /home/itsoa/sites && test -d /home/itsob/sites && echo yes)
  renamed=$(ls -d /etc/itso.removed-* 2>/dev/null | head -1)
  if [ "$rc" -eq 0 ] && [ "$kept" = yes ] && [ -n "$renamed" ] && ! systemctl is-active -q itso-agent; then
    row U2 "itso uninstall" "giữ /home, đổi tên /etc/itso, dừng dịch vụ" PASS "/home còn; $renamed"
  else
    row U2 "itso uninstall" "giữ /home, đổi tên /etc/itso" FAIL "exit $rc, /home: ${kept:-mất}, /etc/itso → ${renamed:-không đổi}"
  fi
else
  row U2 "itso uninstall" "giữ /home" SKIP "--no-uninstall"
fi

[ "$FAIL" -eq 0 ]
