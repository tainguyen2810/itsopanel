#!/usr/bin/env bash
# Bộ test VM Phase 11 (Monitoring, Alerts, Notifications) — 1 VM Ubuntu 24.04 ĐÃ CÀI ITSO (sau
# run-all.sh --no-uninstall), scheduler + queue `notifications` chạy bằng systemd như máy thật.
# KHÔNG chạy trên máy thật: script dùng fallocate đẩy / lên > 90 %, dừng itso-agent, dừng nginx, thêm dòng /etc/hosts.
#
#   sudo bash tests/vm/phase11.sh            M0–M5 → /root/itso-vm-phase11.md
#   sudo bash tests/vm/phase11.sh --cleanup  xóa file fallocate, bật lại agent/nginx, gỡ /etc/hosts
#
#   M0 số liệu thật: RAM/disk server so với /proc/meminfo + statvfs; RAM account so với memory.current của
#      cgroup v2 thật (itso-acct-<uid>.slice) sau itso:usage-refresh
#   M1 fallocate đẩy / > 90 % → cảnh báo "Disk server > 90%" firing ≤ 2 phút (rule kéo dài 60 giây) → xóa → resolved
#   M2 dừng itso-agent (socket mất; máy node: chặn cổng relay bằng nftables, xem docs/runbooks/phase-11-monitoring.md)
#      → "Server mất kết nối" firing ≤ 2 phút → bật lại → resolved
#   M3 uptime nginx thật: site lên → dừng nginx → down sau 3 lần kiểm → bật → up; chứng chỉ khi ITSO_VM_ACME=1
#   M4 email qua SMTP thật khi có ITSO_VM_SMTP_HOST (+ _PORT, _USER, _PASS, _FROM, _TO, _ENC); không có → SKIP
#   M5 webhook tới IP riêng: lưu URL IP riêng không bật cờ → 422; tên miền (qua /etc/hosts) trỏ IP riêng → delivery
#      `blocked`, không có gói tin nào ra IP đó (nft counter)
#
# Panel được gọi trong tiến trình (lib/panel_api.php, như Phase 9–10): validate, phạm vi, job, audit như khi gọi HTTP.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

REPORT="${REPORT:-/root/itso-vm-phase11.md}"
ST=/root/itso-vm11
FILL=/var/tmp/itso-vm11-fill
PRIV_IP=10.255.11.11
MODE=main
while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT="$2"; shift 2 ;;
    --cleanup) MODE=cleanup; shift ;;
    *) shift ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "cần root (VM test)" >&2; exit 2; }
trap 'write_report' EXIT

cleanup() {
  rm -f "$FILL"
  sed -i '/# itso-vm11$/d' /etc/hosts
  nft delete table inet itso_vm11 2>/dev/null || true
  systemctl start itso-agent nginx 2>/dev/null || true
}
if [ "$MODE" = cleanup ]; then
  cleanup
  row C0 "dọn fallocate, /etc/hosts, nft, bật agent + nginx" "xong" PASS "website/kênh thử giữ lại để xem trong panel"
  exit 0
fi
[ -S /run/itso/agent.sock ] || { echo "chưa có itso-agent (chạy run-all.sh --no-uninstall trước)" >&2; exit 2; }

ART="frankenphp php-cli /opt/itso/current/api/artisan"
LIB=/tmp/itso-vm11-panel_api.php
as_itso() { setpriv --reuid=itso --regid="$(id -g itso)" --init-groups "$@"; }
artisan() { as_itso $ART "$@" --no-interaction 2>&1; }
api() {
  install -m 0644 "$VM_DIR/lib/panel_api.php" "$LIB"
  VM_METHOD="$1" VM_PATH="/api/v1/admin$2" VM_BODY="${3:-{\}}" as_itso $ART tinker --no-interaction \
    --execute "require '$LIB'; vm_api_main();" 2>/dev/null | sed -n 's/^@@//p' | tail -n1
}
st() { jget "$1" 'd["status"]'; }
b() { jget "$1" "d['body']$2"; }
detail() { jget "$1" "(d['body'] or {}).get('detail') or (d['body'] or {}).get('title') or ''"; }
job_wait() {
  local id s="" i
  id=$(b "$1" '["job"]["uuid"]')
  [ -n "$id" ] || { echo "no_job $(st "$1") $(detail "$1")"; return; }
  for i in $(seq 1 "${2:-600}"); do
    s=$(b "$(api GET "/jobs/$id")" '["data"]["state"]')
    case "$s" in succeeded|failed|cancelled|timed_out) break ;; esac
    sleep 1
  done
  echo "$s"
}
# firing_for <tên rule> <uuid đối tượng> → "1" nếu đang firing
firing_for() {
  jget "$(api GET '/alerts?filter[state]=firing&per_page=100')" \
    "int(any(a['rule']['name']=='$1' and a['resource']['uuid']=='$2' for a in d['body']['data']))"
}
# wait_alert <tên rule> <uuid> <0|1> <giây> → số giây chờ, hoặc "timeout"
wait_alert() {
  local t0=$SECONDS
  while [ $((SECONDS - t0)) -le "$4" ]; do
    [ "$(firing_for "$1" "$2")" = "$3" ] && { echo $((SECONDS - t0)); return; }
    sleep 5
  done
  echo timeout
}

mkdir -p "$ST" && chmod 0700 "$ST"
SRV=$(jget "$(api GET '/servers?per_page=100')" "d['body']['data'][0]['uuid']")
[ -n "$SRV" ] || { echo "không đọc được server từ panel" >&2; exit 2; }
ACC=$(jget "$(api GET '/hosting-accounts?per_page=100')" "next((a['uuid'] for a in d['body']['data'] if a['server']['uuid']=='$SRV' and a['status']=='active'), '')")
if [ -z "$ACC" ]; then
  r=$(api GET '/hosting-packages?per_page=10'); pkg=$(b "$r" '["data"][0]["uuid"]')
  r=$(api POST /hosting-accounts "{\"server_uuid\":\"$SRV\",\"package_uuid\":\"$pkg\",\"username\":\"vm11\",\"primary_domain\":\"vm11.itso.test\",\"owner\":{\"name\":\"VM11\",\"email\":\"vm11@example.test\"}}")
  [ "$(job_wait "$r" 300)" = succeeded ] && ACC=$(b "$r" '["resource"]["uuid"]')
fi
ACCN=$(jget "$(api GET "/hosting-accounts/$ACC")" 'd["body"]["data"]["username"]')
UID_A=$(id -u "$ACCN" 2>/dev/null)

# ---------------------------------------------------------------- M0 số liệu thật
artisan itso:metrics-collect >/dev/null
# Tạo tải nhỏ trong slice account để memory.current > 0 rồi thu cgroup.
as_acct "$ACCN" "itso-acct-$UID_A.slice" python3 -c 'b=bytearray(48*1024*1024); import time; time.sleep(8)' &
sleep 4
artisan itso:usage-refresh >/dev/null
wait
ram_api=$(jget "$(api GET "/metrics/servers/$SRV?metric=ram_pct&range=1h")" "d['body']['data']['points'][-1][1]")
ram_os=$(awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{printf "%.1f", (t-a)*100/t}' /proc/meminfo)
disk_api=$(jget "$(api GET "/metrics/servers/$SRV?metric=disk_pct&range=1h")" "d['body']['data']['points'][-1][1]")
disk_os=$(df --output=pcent / | tail -n1 | tr -dc 0-9)
acc_row=$(api GET "/metrics/servers/$SRV/accounts?q=$ACCN")
acc_ram=$(jget "$acc_row" "next((r['ram_mb'] for r in d['body']['data'] if r['hosting_account']['username']=='$ACCN'), -1)")
cg=/sys/fs/cgroup/itso.slice/itso-acct.slice/itso-acct-$UID_A.slice
near() { python3 -c "import sys; sys.exit(0 if abs(float('$1')-float('$2'))<=float('$3') else 1)" 2>/dev/null; }
if [ -d "$cg" ] && near "$ram_api" "$ram_os" 10 && near "$disk_api" "$disk_os" 2 && [ "${acc_ram%.*}" -ge 0 ] 2>/dev/null; then
  row M0 "số liệu thật /proc + cgroup v2 theo account" "RAM ±10 điểm, disk ±2 điểm; slice account có số liệu" PASS "RAM panel $ram_api% / OS $ram_os%; disk $disk_api% / $disk_os%; $ACCN ram_mb $acc_ram (cgroup $cg)"
else
  row M0 "số liệu thật /proc + cgroup v2" "khớp OS + có slice account" FAIL "RAM $ram_api/$ram_os; disk $disk_api/$disk_os; acc $acc_ram; slice $([ -d "$cg" ] && echo có || echo thiếu)"
fi

# ---------------------------------------------------------------- M1 disk > 90 % (fallocate)
read -r total used <<<"$(df -B1 --output=size,used / | tail -n1)"
need=$(python3 -c "print(max(0, int($total*0.92) - $used))")
rm -f "$FILL"
if fallocate -l "$need" "$FILL" 2>/dev/null; then
  t=$(wait_alert 'Disk server > 90%' "$SRV" 1 180)
  rm -f "$FILL"
  tr=$(wait_alert 'Disk server > 90%' "$SRV" 0 240)
  if [ "$t" != timeout ] && [ "$t" -le 120 ] && [ "$tr" != timeout ]; then
    row M1 "disk > 90 % → cảnh báo" "firing ≤ 120 giây; xóa file → resolved" PASS "firing sau ${t}s; resolved sau ${tr}s; df $(df --output=pcent / | tail -n1)"
  else
    row M1 "disk > 90 % → cảnh báo" "firing ≤ 120 giây + resolved" FAIL "firing: $t; resolved: $tr"
  fi
else
  row M1 "disk > 90 % (fallocate $need byte)" "tạo được file" FAIL "fallocate lỗi (FS không hỗ trợ?)"
fi

# ---------------------------------------------------------------- M2 mất kết nối agent
systemctl stop itso-agent
t=$(wait_alert 'Server mất kết nối' "$SRV" 1 180)
systemctl start itso-agent
sleep 3
tr=$(wait_alert 'Server mất kết nối' "$SRV" 0 240)
if [ "$t" != timeout ] && [ "$t" -le 120 ] && [ "$tr" != timeout ]; then
  row M2 "dừng itso-agent → mất kết nối" "firing ≤ 120 giây; bật lại → resolved" PASS "firing sau ${t}s; resolved sau ${tr}s"
else
  row M2 "dừng itso-agent → mất kết nối" "firing ≤ 120 giây + resolved" FAIL "firing: $t; resolved: $tr"
fi

# ---------------------------------------------------------------- M3 uptime nginx thật
SSL=none; [ "${ITSO_VM_ACME:-0}" = 1 ] && SSL=acme
dom="up.vm11.itso.test"
r=$(api POST /websites "{\"hosting_account_uuid\":\"$ACC\",\"primary_domain\":\"$dom\",\"type\":\"static\",\"ssl_mode\":\"$SSL\"}")
s=$(job_wait "$r" 300); W=$(b "$r" '["resource"]["uuid"]')
echo "127.0.0.1 $dom # itso-vm11" >>/etc/hosts
c=$(api POST /uptime-checks "{\"website_uuid\":\"$W\"}")
CK=$(jget "$c" "d['body']['data']['uuid'] if d['status']==201 else ''")
[ -n "$CK" ] || CK=$(jget "$(api GET '/uptime-checks?per_page=100')" "next((x['uuid'] for x in d['body']['data'] if x['website']['uuid']=='$W'), '')")
ustate() { jget "$(api GET '/uptime-checks?per_page=100')" "next((x['state'] for x in d['body']['data'] if x['uuid']=='$CK'), '')"; }
artisan itso:uptime-probe --all >/dev/null
s1=$(ustate)
systemctl stop nginx
for _ in 1 2 3; do artisan itso:uptime-probe --all >/dev/null; done
s2=$(ustate)
systemctl start nginx
artisan itso:uptime-probe --all >/dev/null
s3=$(ustate)
cert=$(jget "$(api GET '/uptime-checks?per_page=100')" "next((x['cert_expires_at'] for x in d['body']['data'] if x['uuid']=='$CK'), None)")
if [ "$s" = succeeded ] && [ "$s1" = up ] && [ "$s2" = down ] && [ "$s3" = up ]; then
  row M3 "uptime nginx thật" "up → dừng nginx → down (3 lần) → up" PASS "SSL $SSL; cert_expires_at $cert"
else
  row M3 "uptime nginx thật" "up → down → up" FAIL "site $s $(detail "$r"); $s1 → $s2 → $s3"
fi
[ "$SSL" = acme ] || row M3b "hạn chứng chỉ TLS" "ITSO_VM_ACME=1 (cần DNS/Pebble)" SKIP "chạy lại với ITSO_VM_ACME=1"

# ---------------------------------------------------------------- M4 SMTP thật
if [ -n "${ITSO_VM_SMTP_HOST:-}" ]; then
  body=$(python3 -c 'import json,os; e=os.environ; print(json.dumps({"host":e["ITSO_VM_SMTP_HOST"],"port":int(e.get("ITSO_VM_SMTP_PORT","587")),"username":e.get("ITSO_VM_SMTP_USER",""),"password":e.get("ITSO_VM_SMTP_PASS") or None,"from":e.get("ITSO_VM_SMTP_FROM","ITSO Panel <panel@itso.local>"),"encryption":e.get("ITSO_VM_SMTP_ENC","starttls")}))')
  p=$(api PATCH /settings/smtp "$body")
  ch=$(api POST /notification-channels "{\"type\":\"email\",\"name\":\"VM11 SMTP\",\"config\":{\"recipients\":[\"${ITSO_VM_SMTP_TO:?cần ITSO_VM_SMTP_TO}\"]}}")
  t=$(api POST "/notification-channels/$(b "$ch" '["data"]["uuid"]'):test")
  if [ "$(st "$p")" = 200 ] && [ "$(b "$t" '["data"]["state"]')" = sent ]; then
    row M4 "email qua SMTP thật" "gửi thử sent; kiểm hộp thư $ITSO_VM_SMTP_TO" PASS "response $(b "$t" '["data"]["response_code"]')"
  else
    row M4 "email qua SMTP thật" "sent" FAIL "settings $(st "$p") $(detail "$p"); $(b "$t" '["data"]["error"]')"
  fi
else
  row M4 "email qua SMTP thật" "cần ITSO_VM_SMTP_HOST/_TO" SKIP "chờ người dùng cấu hình SMTP"
fi

# ---------------------------------------------------------------- M5 webhook tới IP riêng bị chặn
lit=$(api POST /notification-channels "{\"type\":\"webhook\",\"name\":\"VM11 literal\",\"config\":{\"url\":\"https://$PRIV_IP/hook\"},\"secret\":\"vm11-secret-0123456789abcdef\"}")
echo "$PRIV_IP hook.vm11.itso.test # itso-vm11" >>/etc/hosts
nft add table inet itso_vm11 && nft add chain inet itso_vm11 out '{ type filter hook output priority 0; }' \
  && nft add rule inet itso_vm11 out ip daddr "$PRIV_IP" counter
hk=$(api POST /notification-channels "{\"type\":\"webhook\",\"name\":\"VM11 private DNS\",\"config\":{\"url\":\"https://hook.vm11.itso.test/hook\"},\"secret\":\"vm11-secret-0123456789abcdef\"}")
t=$(api POST "/notification-channels/$(b "$hk" '["data"]["uuid"]'):test")
pk=$(nft list chain inet itso_vm11 out 2>/dev/null | grep -o 'packets [0-9]*' | awk '{print $2}')
if [ "$(st "$lit")" = 422 ] && [ "$(st "$hk")" = 201 ] && [ "$(b "$t" '["data"]["state"]')" = blocked ] && [ "${pk:-1}" = 0 ]; then
  row M5 "webhook tới IP riêng" "IP riêng 422; DNS → IP riêng: blocked, 0 gói tin ra" PASS "$(b "$t" '["data"]["error"]' | cut -c1-120)"
else
  row M5 "webhook tới IP riêng" "422 + blocked + 0 gói" FAIL "literal $(st "$lit"); kênh $(st "$hk"); test $(b "$t" '["data"]["state"]'); packets $pk"
fi
sed -i '/hook.vm11.itso.test # itso-vm11$/d' /etc/hosts
nft delete table inet itso_vm11 2>/dev/null || true

[ "$FAIL" -eq 0 ]
