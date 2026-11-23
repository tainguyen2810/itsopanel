#!/usr/bin/env bash
# Vòng cập nhật/quay lại + chaos (Prompt 12.6, D-114, ADR 0059) — chạy bằng root trong VM Ubuntu 24.04 ĐÃ CÀI ITSO bản
# --release (sau run-all.sh --no-uninstall). KHÔNG chạy trên máy thật: script kill -9 tiến trình cập nhật và có thể
# khởi động lại máy bằng sysrq.
#
#   sudo bash tests/vm/upgrade-loop.sh --release <bản đang cài> --release2 <bản mới> [--rounds 20] [--no-chaos]
#   sudo bash tests/vm/upgrade-loop.sh --release … --release2 … --reboot <bước>   (sysrq b giữa lúc cập nhật; chạy lại
#                                                                                 đúng lệnh sau khi VM lên để kiểm phần sau)
#
# Mỗi vòng i: itso update → (chaos: kill -9 khi journal tới bước STEPS[i % 6] → itso repair --fix → nếu còn bản cũ thì
# update lại) → kiểm (version, itso doctor, /api/v1/system/health) → itso rollback → kiểm. Suốt quá trình một tiến trình
# nền gọi site của account 5 lần/giây qua nginx: **site account phải 0 lỗi HTTP** (nginx/PHP-FPM của account không phụ
# thuộc panel). Thời gian panel gián đoạn (health ≠ 200) ghi để tham khảo.
# Kết quả: $REPORT (mặc định /root/itso-vm-upgrade-loop.md). Thoát 1 nếu có FAIL.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

REPORT="${REPORT:-/root/itso-vm-upgrade-loop.md}"
REL="" REL2="" ROUNDS=20 CHAOS=1 REBOOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release) REL="$2"; shift 2 ;;
    --release2) REL2="$2"; shift 2 ;;
    --rounds) ROUNDS="$2"; shift 2 ;;
    --no-chaos) CHAOS=0; shift ;;
    --reboot) REBOOT="$2"; shift 2 ;;
    --report) REPORT="$2"; shift 2 ;;
    *) echo "tham số lạ: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "cần root (VM test)" >&2; exit 2; }
[ -f "$REL/manifest.json" ] && [ -f "$REL2/manifest.json" ] || { echo "--release và --release2 phải là thư mục make release" >&2; exit 2; }
command -v itso >/dev/null && [ -S /run/itso/agent.sock ] || { echo "chưa cài ITSO (run-all.sh --no-uninstall trước)" >&2; exit 2; }
[[ "$ROUNDS" =~ ^[0-9]+$ ]] || { echo "--rounds phải là số" >&2; exit 2; }

STEPS=(downloaded verified extracted migrated switched restarted)
JOURNAL=/var/lib/itso/update.journal
ST=/root/itso-vm-upgrade
SITE=vm12.itso.test
mkdir -p "$ST" && chmod 0700 "$ST"
V1=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REL/manifest.json")
V2=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$REL2/manifest.json")
ver() { itso version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?' | head -n1; }
panel_ok() { [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "https://127.0.0.1:$(python3 -c 'import json; print(json.load(open("/etc/itso/panel.json"))["port"])')/api/v1/system/health")" = 200 ]; }
healthy() { itso doctor >/dev/null 2>&1 && panel_ok; }
wait_healthy() { local i; for i in $(seq 1 "${1:-120}"); do healthy && return 0; sleep 1; done; return 1; }
trap 'kill "$PROBE" "$PPROBE" 2>/dev/null; write_report' EXIT

# ------------------------------------------------------------ site account để đo gián đoạn
ART="frankenphp php-cli /opt/itso/current/api/artisan"
LIB=/tmp/itso-vm12-panel_api.php
as_itso() { setpriv --reuid=itso --regid="$(id -g itso)" --init-groups "$@"; }
api() {
  install -m 0644 "$VM_DIR/lib/panel_api.php" "$LIB"
  VM_METHOD="$1" VM_PATH="/api/v1/admin$2" VM_BODY="${3:-{\}}" as_itso $ART tinker --no-interaction \
    --execute "require '$LIB'; vm_api_main();" 2>/dev/null | sed -n 's/^@@//p' | tail -n1
}
if [ ! -f "$ST/site" ]; then
  SRV=$(jget "$(api GET '/servers?per_page=100')" "d['body']['data'][0]['uuid']")
  pkg=$(jget "$(api GET '/hosting-packages?per_page=10')" "d['body']['data'][0]['uuid']")
  r=$(api POST /hosting-accounts "{\"server_uuid\":\"$SRV\",\"package_uuid\":\"$pkg\",\"username\":\"vm12\",\"primary_domain\":\"$SITE\",\"owner\":{\"name\":\"VM12\",\"email\":\"vm12@example.test\"}}")
  for _ in $(seq 1 300); do
    id vm12 >/dev/null 2>&1 && [ "$(curl -s -o /dev/null -w '%{http_code}' --resolve "$SITE:80:127.0.0.1" "http://$SITE/")" != 000 ] && break
    sleep 1
  done
  doc=$(find /home/vm12 -maxdepth 4 -type d -path "*$SITE*" -name public_html 2>/dev/null | head -n1)
  [ -n "$doc" ] && as_acct vm12 "itso-acct-$(id -u vm12).slice" sh -c "echo itso-vm12-ok > '$doc/index.html'"
  echo "$SITE" > "$ST/site"
fi
code=$(curl -s --resolve "$SITE:80:127.0.0.1" "http://$SITE/" 2>/dev/null)
[ "$code" = itso-vm12-ok ] || { row S0 "site account để đo" "trả itso-vm12-ok" FAIL "nhận: ${code:0:80}"; exit 1; }

# Tiến trình nền: site account 5 lần/giây (mã HTTP), panel 1 lần/giây.
: > "$ST/site.log"; : > "$ST/panel.log"
( while :; do curl -s -o /dev/null -w '%{http_code}\n' --max-time 2 --resolve "$SITE:80:127.0.0.1" "http://$SITE/" >> "$ST/site.log"; sleep 0.2; done ) &
PROBE=$!
( while :; do if panel_ok; then echo 1; else echo 0; fi >> "$ST/panel.log"; sleep 1; done ) &
PPROBE=$!

# ------------------------------------------------------------ khởi động lại giữa chừng (sysrq b)
if [ -n "$REBOOT" ]; then
  if [ -f "$ST/rebooted" ]; then
    j=$( [ -f "$JOURNAL" ] && cat "$JOURNAL" || echo '-')
    itso repair --fix > "$ST/repair.log" 2>&1; rc=$?
    v=$(ver)
    if [ $rc -eq 0 ] && [ ! -f "$JOURNAL" ] && { [ "$v" = "$V1" ] || [ "$v" = "$V2" ]; } && wait_healthy 120; then
      row R1 "mất điện (sysrq b) ở bước $(cat "$ST/rebooted")" "repair --fix hoàn tất hoặc quay lại, panel khỏe" PASS "journal: ${j:0:120}; bản $v"
    else
      row R1 "mất điện ở bước $(cat "$ST/rebooted")" "repair --fix đưa về trạng thái nhất quán" FAIL "rc $rc, bản $v, journal còn: $([ -f "$JOURNAL" ] && echo có || echo không) (xem $ST/repair.log)"
    fi
    rm -f "$ST/rebooted"
    exit
  fi
  [[ " ${STEPS[*]} " == *" $REBOOT "* ]] || { echo "--reboot phải là một trong: ${STEPS[*]}" >&2; exit 2; }
  echo 1 > /proc/sys/kernel/sysrq
  itso update --release-dir "$REL2" > "$ST/update-reboot.log" 2>&1 &
  for _ in $(seq 1 6000); do
    [ "$(jget "$(cat "$JOURNAL" 2>/dev/null || echo '{}')" 'd.get("step","")')" = "$REBOOT" ] && break
    sleep 0.05
  done
  echo "$REBOOT" > "$ST/rebooted"; sync
  echo b > /proc/sysrq-trigger
  sleep 60
fi

# ------------------------------------------------------------ vòng cập nhật/quay lại
[ "$(ver)" = "$V1" ] || itso rollback >/dev/null 2>&1 || true
[ "$(ver)" = "$V1" ] || { row U0 "bắt đầu từ bản $V1" "itso version = $V1" FAIL "đang là $(ver)"; exit 1; }
max_round=0
for i in $(seq 1 "$ROUNDS"); do
  t0=$SECONDS; note=""
  if [ "$CHAOS" = 1 ]; then
    target=${STEPS[$(( (i - 1) % 6 ))]}
    itso update --release-dir "$REL2" > "$ST/update-$i.log" 2>&1 &
    up=$!
    hit=0
    for _ in $(seq 1 6000); do
      kill -0 "$up" 2>/dev/null || break
      if [ "$(jget "$(cat "$JOURNAL" 2>/dev/null || echo '{}')" 'd.get("step","")')" = "$target" ]; then kill -9 "$up"; hit=1; break; fi
      sleep 0.05
    done
    wait "$up" 2>/dev/null
    if [ $hit = 1 ]; then
      itso repair --fix >> "$ST/update-$i.log" 2>&1
      note="kill -9 ở $target → repair → bản $(ver)"
    else
      note="update xong trước bước $target (không chaos được)"
    fi
    [ "$(ver)" = "$V2" ] || itso update --release-dir "$REL2" >> "$ST/update-$i.log" 2>&1
  else
    itso update --release-dir "$REL2" > "$ST/update-$i.log" 2>&1
  fi
  okup=0; [ "$(ver)" = "$V2" ] && [ ! -f "$JOURNAL" ] && wait_healthy 120 && okup=1
  itso rollback >> "$ST/update-$i.log" 2>&1
  okdown=0; [ "$(ver)" = "$V1" ] && wait_healthy 120 && okdown=1
  dt=$((SECONDS - t0)); [ $dt -gt $max_round ] && max_round=$dt
  if [ $okup = 1 ] && [ $okdown = 1 ]; then
    row "U$i" "vòng $i: update → kiểm → rollback" "$V1 → $V2 → $V1, doctor + health OK" PASS "${dt}s; $note"
  else
    row "U$i" "vòng $i: update → kiểm → rollback" "$V1 → $V2 → $V1" FAIL "lên: $okup, về: $okdown, bản $(ver); $note (xem $ST/update-$i.log)"
  fi
done

kill "$PROBE" "$PPROBE" 2>/dev/null; sleep 1
total=$(wc -l < "$ST/site.log"); bad=$(grep -cv '^200$' "$ST/site.log")
if [ "$total" -gt 0 ] && [ "$bad" -eq 0 ]; then
  row S1 "site account trong suốt $ROUNDS vòng" "0 lỗi HTTP" PASS "$total yêu cầu, 0 lỗi"
else
  row S1 "site account trong suốt $ROUNDS vòng" "0 lỗi HTTP" FAIL "$bad/$total yêu cầu lỗi: $(grep -v '^200$' "$ST/site.log" | sort | uniq -c | tr '\n' ' ')"
fi
down=$(grep -c '^0$' "$ST/panel.log")
row P1 "panel gián đoạn (tham khảo)" "chỉ lúc restart" WARN "tổng ${down}s panel health ≠ 200 trong $(wc -l < "$ST/panel.log")s; vòng dài nhất ${max_round}s"
[ "$FAIL" -eq 0 ]
