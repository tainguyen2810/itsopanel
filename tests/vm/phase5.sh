#!/usr/bin/env bash
# Bộ test VM Phase 5 (Website / Nginx / PHP-FPM / SSL) — chạy bằng root trong VM Ubuntu 24.04 ĐÃ CÀI ITSO
# (sau run-all.sh --no-uninstall), dùng một lần. KHÔNG chạy trên máy thật.
#
#   sudo bash tests/vm/phase5.sh [--report /root/itso-vm-phase5.md] [--sites 20]
#
# Gọi agent thật qua socket (ký HMAC, lib/agent_call.py) như Laravel làm, không qua UI:
#   W0 cài web stack (recipe nginx, lego; php.version.install 8.3)
#   W1 20 site PHP (2 account) → mỗi site HTTP 200, PHP chạy đúng uid account
#   W2 account A không đọc được file của B qua PHP (open_basedir + quyền), không đọc /etc/shadow
#   W3 nginx -t lỗi khi áp vhost → agent hoàn tác (config_test_failed), không còn file vhost mới, 20 site vẫn 200
#   W4 Pebble cấp chứng chỉ qua HTTP-01 thật (Pebble gọi Nginx cổng 80) → HTTPS phục vụ đúng chứng chỉ; gia hạn
#      ra chứng chỉ mới (chạy trước: ITSO_PEBBLE_VM=1 bash tests/vm/pebble/start.sh)
#   W5 xóa site (vhost.remove + pool.remove + cert.remove) không để lại cấu hình
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

REPORT="${REPORT:-/root/itso-vm-phase5.md}"
N=20
while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT="$2"; shift 2 ;;
    --sites) N="$2"; shift 2 ;;
    *) echo "tham số lạ: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "cần root (VM test)" >&2; exit 2; }
[ -S /run/itso/agent.sock ] || { echo "chưa có itso-agent (chạy run-all.sh --no-uninstall trước)" >&2; exit 2; }
trap write_report EXIT

LIMITS='{"disk_mb":500,"inode_limit":50000,"cpu_percent":100,"ram_mb":512,"tasks_max":128,"io_weight":100,"io_read_bps":null,"io_write_bps":null}'
ok() { [ "$(jget "$1" 'd["body"]["ok"]')" = True ]; }
err() { jget "$1" 'd["body"]["error"]["code"] + ": " + d["body"]["error"]["message"][:160]'; }
acct() { echo "{\"username\":\"$1\",\"uid\":$2}"; }
uuid_of() { printf '01938a99-%04d-7000-8000-%012d' "$1" "$1"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' -H "Host: $1" "http://127.0.0.1${2:-/}"; }

# ---------------------------------------------------------------- W0 web stack
w0=""
for r in nginx lego; do
  res=$(agent software.install "{\"recipe\":\"$r\"}")
  ok "$res" || w0+="$r: $(err "$res"); "
done
res=$(agent php.version.install '{"version":"8.3","extensions":[]}')
ok "$res" || w0+="php8.3: $(err "$res"); "
if [ -z "$w0" ] && command -v nginx >/dev/null && [ -x /usr/sbin/php-fpm8.3 ] && [ -x /usr/bin/lego ]; then
  row W0 "Cài web stack qua agent (nginx, lego, PHP 8.3)" "ok" PASS "$(nginx -v 2>&1); $(/usr/sbin/php-fpm8.3 -v | head -n1); $(/usr/bin/lego --version 2>&1 | head -n1)"
else
  row W0 "Cài web stack qua agent" "ok" FAIL "${w0:-thiếu binary sau khi cài}"
fi

# ---------------------------------------------------------------- tài khoản
declare -A UID_OF=([itsoc]=20101 [itsod]=20102)
for u in itsoc itsod; do
  res=$(agent account.ensure "{\"account\":$(acct "$u" "${UID_OF[$u]}"),\"home_path\":\"/home/$u\",\"shell\":\"/usr/sbin/nologin\",\"limits\":$LIMITS}")
  ok "$res" || row W0b "Tạo account $u" "ok" FAIL "$(err "$res")"
done

# PHP thử: in uid tiến trình và thử đọc file theo ?f= (kiểm cô lập).
PHP_PROBE='<?php header("Content-Type: text/plain"); echo "uid=", posix_geteuid(), "\n"; if (isset($_GET["f"])) { $c = @file_get_contents($_GET["f"]); echo $c === false ? "DENIED" : "READ"; }'
DISABLED='["exec","shell_exec","system","passthru","proc_open","popen","pcntl_exec"]'

# make_site <i> <user> [tls cert_uuid] → in ra lỗi (rỗng = ok)
make_site() {
  local i="$1" u="$2" cert="${3:-}" id dom a res sock tls
  id=$(uuid_of "$i")
  dom="site$i.vm5.itso.test"
  a=$(acct "$u" "${UID_OF[$u]}")
  res=$(agent fs.site_layout.ensure "{\"account\":$a,\"site_dir\":\"$dom\"}")
  ok "$res" || { echo "layout: $(err "$res")"; return; }
  res=$(agent php.pool.apply "{\"account\":$a,\"website_uuid\":\"$id\",\"site_dir\":\"$dom\",\"version\":\"8.3\",\"pm_max_children\":2,\"memory_limit\":\"128m\",\"max_execution_time\":30,\"upload_max_filesize\":\"16m\",\"disable_functions\":$DISABLED}")
  ok "$res" || { echo "pool: $(err "$res")"; return; }
  sock=$(jget "$res" 'd["body"]["data"]["socket"]')
  tls=null
  [ -n "$cert" ] && tls="{\"cert_uuid\":\"$cert\",\"hsts\":false,\"force_https\":false}"
  res=$(agent nginx.vhost.apply "{\"account\":$a,\"website_uuid\":\"$id\",\"site_dir\":\"$dom\",\"type\":\"php\",\"server_names\":[\"$dom\"],\"document_root\":\"public\",\"php_socket\":\"$sock\",\"tls\":$tls,\"client_max_body_size\":\"16m\",\"extra_headers\":{},\"suspended\":false,\"redirect_names\":[],\"http2\":true,\"proxy_port\":null,\"redirects\":[]}")
  ok "$res" || { echo "vhost: $(err "$res")"; return; }
  printf '%s' "$PHP_PROBE" >"/home/$u/sites/$dom/public/index.php"
  chown "$u:$u" "/home/$u/sites/$dom/public/index.php"
}

user_of() { if [ $(($1 % 2)) -eq 1 ]; then echo itsoc; else echo itsod; fi; }

# ---------------------------------------------------------------- W1 N site, đúng uid
t0=$(date +%s)
fails=""
for i in $(seq 1 "$N"); do
  e=$(make_site "$i" "$(user_of "$i")")
  [ -n "$e" ] && fails+="site$i $e; "
done
bad=""
for i in $(seq 1 "$N"); do
  u=$(user_of "$i")
  body=$(curl -s -H "Host: site$i.vm5.itso.test" http://127.0.0.1/)
  [ "$body" = "uid=${UID_OF[$u]}" ] || bad+="site$i→'${body:0:40}'; "
done
dt=$(($(date +%s) - t0))
if [ -z "$fails" ] && [ -z "$bad" ]; then
  row W1 "$N site PHP trên 2 account" "mọi site 200, PHP chạy đúng uid account" PASS "$N/$N site trả uid đúng (${UID_OF[itsoc]}/${UID_OF[itsod]}); ${dt} giây"
else
  row W1 "$N site PHP trên 2 account" "mọi site 200, đúng uid" FAIL "${fails}${bad}"
fi

# ---------------------------------------------------------------- W2 cô lập account qua PHP
other="/home/itsod/sites/site2.vm5.itso.test/public/index.php"
r1=$(curl -s -H "Host: site1.vm5.itso.test" "http://127.0.0.1/?f=$other" | tail -n1)
r2=$(curl -s -H "Host: site1.vm5.itso.test" "http://127.0.0.1/?f=/etc/shadow" | tail -n1)
r3=$(curl -s -H "Host: site1.vm5.itso.test" "http://127.0.0.1/?f=/home/itsoc/sites/site1.vm5.itso.test/public/index.php" | tail -n1)
if [ "$r1" = DENIED ] && [ "$r2" = DENIED ] && [ "$r3" = READ ]; then
  row W2 "PHP của A đọc file của B, /etc/shadow" "DENIED (file của chính A vẫn đọc được)" PASS "B: $r1, shadow: $r2, của A: $r3"
else
  row W2 "PHP của A đọc file của B, /etc/shadow" "DENIED" FAIL "B: $r1, shadow: $r2, của A: $r3"
fi

# ---------------------------------------------------------------- W3 nginx -t lỗi → hoàn tác, site khác vẫn chạy
# Mô phỏng cấu hình hỏng có sẵn (sửa tay sai): nginx -t của lần áp vhost tiếp theo thất bại.
BROKEN=/etc/nginx/conf.d/zz-itso-vm-broken.conf
echo 'this_directive_does_not_exist on;' >"$BROKEN"
K=$((N + 1))
e=$(make_site "$K" itsoc)
rm -f "$BROKEN"
left=$(grep -rl "$(uuid_of "$K")" /etc/nginx 2>/dev/null | head -n3)
still=0
for i in $(seq 1 "$N"); do [ "$(http_code "site$i.vm5.itso.test")" = 200 ] && still=$((still + 1)); done
if [[ "$e" == vhost:\ config_test_failed* ]] && [ -z "$left" ] && [ "$still" = "$N" ] && nginx -t >/dev/null 2>&1; then
  row W3 "Áp vhost khi nginx -t lỗi" "config_test_failed, hoàn tác, $N site khác vẫn 200" PASS "${e:0:120}; không còn vhost mới; $still/$N site 200"
else
  row W3 "Áp vhost khi nginx -t lỗi" "config_test_failed, hoàn tác" FAIL "lỗi='$e'; còn file: ${left:-không}; $still/$N site 200"
fi
agent php.pool.remove "{\"account\":$(acct itsoc 20101),\"website_uuid\":\"$(uuid_of "$K")\"}" >/dev/null

# ---------------------------------------------------------------- W4 Pebble: cấp + gia hạn
CERT=01938a98-0001-7000-8000-000000000001
if [ -s /etc/itso/acme/pebble-ca.pem ] && curl -fsS --cacert /etc/itso/acme/pebble-ca.pem https://localhost:14000/dir >/dev/null 2>&1; then
  issue() {
    agent cert.issue "{\"account\":$(acct itsoc 20101),\"website_uuid\":\"$(uuid_of 1)\",\"cert_uuid\":\"$CERT\",\"site_dir\":\"site1.vm5.itso.test\",\"domains\":[\"site1.vm5.itso.test\"],\"challenge\":\"http-01\",\"email\":\"ops@itso.test\",\"directory\":\"pebble\",\"renew\":$1}"
  }
  res=$(issue false)
  if ok "$res"; then
    fp() { openssl x509 -in "/etc/itso/certs/$CERT/fullchain.pem" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 | cut -c1-23; }
    s1=$(fp)
    e=$(make_site 1 itsoc "$CERT")
    issuer=$(echo | openssl s_client -connect 127.0.0.1:443 -servername site1.vm5.itso.test 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null)
    https=$(curl -sk -o /dev/null -w '%{http_code}' --resolve site1.vm5.itso.test:443:127.0.0.1 https://site1.vm5.itso.test/)
    res=$(issue true)
    s2=$(fp)
    if [ -z "$e" ] && [[ "$issuer" == *ebble* ]] && [ "$https" = 200 ] && ok "$res" && [ "$s1" != "$s2" ]; then
      row W4 "Pebble: cấp chứng chỉ, HTTPS, gia hạn" "HTTPS 200 bằng chứng chỉ Pebble; gia hạn ra chứng chỉ mới" PASS "$issuer; SHA-256 $s1… → $s2…"
    else
      row W4 "Pebble: cấp chứng chỉ, HTTPS, gia hạn" "HTTPS 200, chứng chỉ mới sau gia hạn" FAIL "vhost='$e' issuer='$issuer' https=$https renew=$(ok "$res" && echo ok || err "$res") $s1→$s2"
    fi
  else
    row W4 "Pebble: cấp chứng chỉ" "ok" FAIL "$(err "$res")"
  fi
else
  row W4 "Pebble: cấp + gia hạn" "chạy được" SKIP "Pebble chưa chạy: bash tests/vm/pebble/start.sh trước"
fi

# ---------------------------------------------------------------- W5 xóa site không để lại cấu hình
rmfail=""
for i in $(seq 1 "$N"); do
  u=$(user_of "$i")
  a=$(acct "$u" "${UID_OF[$u]}")
  for op in nginx.vhost.remove php.pool.remove; do
    res=$(agent "$op" "{\"account\":$a,\"website_uuid\":\"$(uuid_of "$i")\"}")
    ok "$res" || rmfail+="site$i $op: $(err "$res"); "
  done
done
agent cert.remove "{\"account\":$(acct itsoc 20101),\"cert_uuid\":\"$CERT\"}" >/dev/null
junk=$(grep -rlE '01938a99-|01938a98-|vm5\.itso\.test' /etc/nginx /etc/itso/php /etc/itso/certs /etc/systemd/system 2>/dev/null | head -n5)
live=$(http_code site1.vm5.itso.test)
if [ -z "$rmfail" ] && [ -z "$junk" ] && [ "$live" != 200 ] && nginx -t >/dev/null 2>&1; then
  row W5 "Xóa $N site" "không còn vhost/pool/chứng chỉ; nginx -t sạch" PASS "site1 sau khi xóa: HTTP $live; không còn file cấu hình nhắc tới site"
else
  row W5 "Xóa $N site" "không còn cấu hình rác" FAIL "${rmfail}còn: ${junk:-không}; site1 HTTP $live"
fi
[ "$FAIL" -eq 0 ]
