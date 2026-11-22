#!/usr/bin/env bash
# Bộ test VM Phase 10 (Docker Manager, WordPress Toolkit, Software) — 1 VM Ubuntu 24.04 ĐÃ CÀI ITSO (sau
# run-all.sh --no-uninstall) + một máy ngoài bất kỳ để thăm dò cổng. KHÔNG chạy trên máy thật: script cài Docker,
# đổi DOCKER-USER, chạy registry thử, chặn tạm downloads.wordpress.org trong /etc/hosts.
#
#   1. VM : sudo bash tests/vm/phase10.sh                       V0 V2 V3 V4 V5 V6 + chuẩn bị V1 (container lỗi cấu hình
#                                                              publish 0.0.0.0:18080 ngoài panel)
#   2. Máy ngoài: bash tests/vm/phase10.sh --probe <IP VM> 18080 closed      → cổng phải KHÔNG vào được
#   3. VM : sudo bash tests/vm/phase10.sh --v1-open              rule firewall scope=docker mở 18080 → docker.firewall.sync
#   4. Máy ngoài: bash tests/vm/phase10.sh --probe <IP VM> 18080 open        → vào được
#   5. VM : sudo bash tests/vm/phase10.sh --cleanup
#
#   V0 bật Docker qua panel (sau `itso policy set docker on`): recipe docker, daemon.json (userland-proxy=false,
#      no-new-privileges, log rotate), nhóm docker rỗng, chuỗi DOCKER-USER có rule của ITSO
#   V1 publish 0.0.0.0 ngoài panel → từ máy ngoài bị chặn; mở trong panel → vào được (chạy ở bước 2–4)
#   V2 compose thật (nginx) qua validator → cổng 127.0.0.1:20000–29999 → website Docker; HTTPS khi ITSO_VM_ACME=1
#   V3 cập nhật image lỗi (bản mới HEALTHCHECK false trên registry thử localhost:5000) → tự quay về image cũ
#   V4 backup volume (pause) → khôi phục ra volume mới → nội dung giống hệt
#   V5 WordPress thật: cài qua panel (mật khẩu chỉ trong response), cập nhật plugin lỗi (chặn tải) → rolled_back,
#      file + DB về như trước; staging (noindex); harden → xmlrpc.php 403, PHP trong uploads 403
#   V6 PHP 8.1/8.2/8.4 song song: mỗi site trả đúng phiên bản của nó
#
# Panel được gọi trong tiến trình (lib/panel_api.php, như Phase 9): validate, phạm vi, job, audit như khi gọi qua HTTP.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

REPORT="${REPORT:-/root/itso-vm-phase10.md}"
ST=/root/itso-vm10
MODE=main
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT="$2"; shift 2 ;;
    --probe|--v1-open|--cleanup) MODE="${1#--}"; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

# ================================================================ --probe (máy ngoài, không cần root)
if [ "$MODE" = probe ]; then
  IP="${ARGS[0]:?cần IP VM}"; PORT="${ARGS[1]:-18080}"; WANT="${ARGS[2]:-closed}"
  REPORT="${REPORT/phase10/phase10-probe-$WANT}"
  trap write_report EXIT
  code=$(curl -s -o /dev/null --connect-timeout 5 --max-time 8 -w '%{http_code}' "http://$IP:$PORT/" || true)
  if { [ "$WANT" = closed ] && [ "$code" = 000 ]; } || { [ "$WANT" = open ] && [ "$code" = 200 ]; }; then
    row V1 "cổng Docker $PORT từ máy ngoài ($WANT)" "$([ "$WANT" = closed ] && echo 'không kết nối được' || echo 'HTTP 200')" PASS "HTTP $code"
  else
    row V1 "cổng Docker $PORT từ máy ngoài ($WANT)" "$WANT" FAIL "HTTP $code"
  fi
  [ "$FAIL" -eq 0 ]; exit
fi

[ "$(id -u)" = 0 ] || { echo "cần root (VM test)" >&2; exit 2; }
[ -S /run/itso/agent.sock ] || { echo "chưa có itso-agent (chạy run-all.sh --no-uninstall trước)" >&2; exit 2; }
trap 'write_report' EXIT

ART="frankenphp php-cli /opt/itso/current/api/artisan"
LIB=/tmp/itso-vm10-panel_api.php
as_itso() { setpriv --reuid=itso --regid="$(id -g itso)" --init-groups "$@"; }
artisan() { as_itso $ART "$@" --no-interaction 2>&1; }
# api <METHOD> <path từ /api/v1/admin> [body JSON] → {"status","body"}
api() {
  install -m 0644 "$VM_DIR/lib/panel_api.php" "$LIB"
  VM_METHOD="$1" VM_PATH="/api/v1/admin$2" VM_BODY="${3:-{\}}" as_itso $ART tinker --no-interaction \
    --execute "require '$LIB'; vm_api_main();" 2>/dev/null | sed -n 's/^@@//p' | tail -n1
}
st() { jget "$1" 'd["status"]'; }
b() { jget "$1" "d['body']$2"; }
detail() { jget "$1" "(d['body'] or {}).get('detail') or (d['body'] or {}).get('title') or ''"; }
job_wait() { # job_wait <JSON 202> [giây] → trạng thái cuối
  local id s="" i
  id=$(b "$1" '["job"]["uuid"]')
  [ -n "$id" ] || { echo "no_job $(st "$1") $(detail "$1")"; return; }
  for i in $(seq 1 "${2:-900}"); do
    s=$(b "$(api GET "/jobs/$id")" '["data"]["state"]')
    case "$s" in succeeded|failed|cancelled|timed_out) break ;; esac
    sleep 1
  done
  echo "$s"
}
res_uuid() { b "$1" '["resource"]["uuid"]'; }
save() { mkdir -p "$ST"; printf '%s=%q\n' "$1" "$2" >>"$ST/state.env"; }
# shellcheck disable=SC1091
load() { [ -f "$ST/state.env" ] && . "$ST/state.env"; }
page() { curl -sk --max-time 20 --resolve "$1:${3:-80}:127.0.0.1" "${2:-http}://$1${4:-/}"; }
page_code() { curl -sk -o /dev/null --max-time 20 -w '%{http_code}' --resolve "$1:${3:-80}:127.0.0.1" "${2:-http}://$1${4:-/}"; }

SRV=$(jget "$(api GET '/servers?per_page=100')" "d['body']['data'][0]['uuid']")
[ -n "$SRV" ] || { echo "không đọc được server từ panel" >&2; exit 2; }

# ================================================================ --v1-open (VM)
if [ "$MODE" = v1-open ]; then
  r=$(api POST "/servers/$SRV/firewall/rules" '{"priority":40,"action":"accept","direction":"in","protocol":"tcp","ports":"18080","source":"0.0.0.0/0","scope":"docker","comment":"vm10 V1"}')
  s=$(job_wait "$(api POST "/servers/$SRV/docker:sync-firewall")" 120)
  rules=$(iptables -S DOCKER-USER 2>/dev/null | grep -c 18080 || true)
  if [ "$(st "$r")" = 201 ] && [ "$s" = succeeded ] && [ "${rules:-0}" -ge 1 ]; then
    row V1b "mở cổng 18080 trong panel (scope=docker)" "rule DOCKER-USER có 18080" PASS "sync $s; $rules rule"
  else
    row V1b "mở cổng 18080 trong panel" "rule 201 + sync succeeded" FAIL "rule $(st "$r") $(detail "$r"); sync $s; rule $rules"
  fi
  echo "Giờ chạy trên máy ngoài: bash tests/vm/phase10.sh --probe <IP VM> 18080 open" >&2
  [ "$FAIL" -eq 0 ]; exit
fi

# ================================================================ --cleanup (VM)
if [ "$MODE" = cleanup ]; then
  docker rm -f vm10-v1 vm10-registry >/dev/null 2>&1
  sed -i '/# itso-vm10$/d' /etc/hosts
  row C0 "dọn container thử + /etc/hosts" "xong" PASS "website/compose/WordPress thử giữ lại để xem trong panel"
  exit 0
fi

mkdir -p "$ST" && chmod 0700 "$ST" && : >"$ST/state.env"
ACC=$(jget "$(api GET '/hosting-accounts?per_page=100')" "next((a['uuid'] for a in d['body']['data'] if a['server']['uuid']=='$SRV' and a['status']=='active'), '')")
if [ -z "$ACC" ]; then
  r=$(api GET '/hosting-packages?per_page=10'); pkg=$(b "$r" '["data"][0]["uuid"]')
  r=$(api POST /hosting-accounts "{\"server_uuid\":\"$SRV\",\"package_uuid\":\"$pkg\",\"username\":\"vm10\",\"primary_domain\":\"vm10.itso.test\",\"owner\":{\"name\":\"VM10\",\"email\":\"vm10@example.test\"}}")
  [ "$(job_wait "$r" 300)" = succeeded ] && ACC=$(res_uuid "$r")
fi
ACCN=$(jget "$(api GET "/hosting-accounts/$ACC")" 'd["body"]["data"]["username"]')
save ACC "$ACC"

# ---------------------------------------------------------------- V6 PHP nhiều bản song song
v6=""; sites=()
for v in 8.1 8.2 8.4; do
  r=$(api POST "/servers/$SRV/software/php$v:install")
  [ "$(st "$r")" = 409 ] || { s=$(job_wait "$r" 900); [ "$s" = succeeded ] || v6+="php$v: $s; "; }
done
for v in 8.1 8.2 8.4; do
  dom="php${v/./}.vm10.itso.test"
  r=$(api POST /websites "{\"hosting_account_uuid\":\"$ACC\",\"primary_domain\":\"$dom\",\"type\":\"php\",\"php_version\":\"$v\",\"ssl_mode\":\"none\"}")
  s=$(job_wait "$r" 300)
  [ "$s" = succeeded ] || { v6+="$dom: $s $(detail "$r"); "; continue; }
  printf '<?php echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;\n' >"/home/$ACCN/sites/$dom/public/v.php"
  chown "$ACCN:$ACCN" "/home/$ACCN/sites/$dom/public/v.php"
  sites+=("$dom=$v")
done
got=""
for x in "${sites[@]}"; do got+="${x%%=*}→$(page "${x%%=*}" http 80 /v.php) "; done
miss=0; for x in "${sites[@]}"; do [ "$(page "${x%%=*}" http 80 /v.php)" = "${x##*=}" ] || miss=1; done
if [ -z "$v6" ] && [ "${#sites[@]}" = 3 ] && [ "$miss" = 0 ] && systemctl is-active --quiet php8.1-fpm php8.2-fpm php8.4-fpm; then
  row V6 "PHP 8.1/8.2/8.4 song song" "mỗi site trả đúng phiên bản; 3 FPM active" PASS "$got"
else
  row V6 "PHP 8.1/8.2/8.4 song song" "mỗi site trả đúng phiên bản" FAIL "$v6 $got"
fi

# ---------------------------------------------------------------- V0 bật Docker
itso policy set docker on >/dev/null 2>&1 && systemctl restart itso-agent && sleep 3
r=$(api POST "/servers/$SRV/docker:enable")
s=$(job_wait "$r" 900)
dj=$(cat /etc/docker/daemon.json 2>/dev/null)
members=$(getent group docker | cut -d: -f4)
du=$(iptables -S DOCKER-USER 2>/dev/null | grep -c -- '-j' || true)
host=$(api GET "/servers/$SRV/docker")
if [ "$s" = succeeded ] && [ "$(b "$host" '["data"]["state"]')" = enabled ] && [ -z "$members" ] \
  && [ "$(jget "$dj" 'd["userland-proxy"] is False and d["no-new-privileges"] is True and bool(d["log-opts"]["max-size"])')" = True ] \
  && [ "${du:-0}" -ge 2 ]; then
  row V0 "bật Docker qua panel" "daemon.json an toàn, nhóm docker rỗng, DOCKER-USER có rule" PASS "engine $(b "$host" '["data"]["engine_version"]'); $du rule DOCKER-USER"
else
  row V0 "bật Docker qua panel" "job succeeded + daemon.json + nhóm rỗng + DOCKER-USER" FAIL "job $s $(detail "$r"); group=[$members]; DOCKER-USER $du; daemon.json ${dj:0:120}"
fi

# V1 (chuẩn bị): container lỗi cấu hình publish 0.0.0.0:18080 NGOÀI panel.
docker rm -f vm10-v1 >/dev/null 2>&1
if docker run -d --name vm10-v1 -p 0.0.0.0:18080:80 nginx:1.27-alpine >/dev/null 2>&1; then
  row V1a "container publish 0.0.0.0:18080 ngoài panel" "chạy; chờ thăm dò từ máy ngoài" WARN "bash tests/vm/phase10.sh --probe $(hostname -I | awk '{print $1}') 18080 closed"
else
  row V1a "container publish 0.0.0.0:18080" "chạy được để thử" FAIL "docker run lỗi"
fi

# ---------------------------------------------------------------- V2 compose thật + website Docker
YAML='services:\n  web:\n    image: nginx:1.27-alpine\n    ports:\n      - "80"\n'
BAD='services:\n  web:\n    image: nginx:1.27-alpine\n    privileged: true\n'
bad=$(api POST /compose-projects "{\"server_uuid\":\"$SRV\",\"name\":\"vm10bad\",\"compose_yaml\":\"$BAD\"}")
r=$(api POST /compose-projects "{\"server_uuid\":\"$SRV\",\"name\":\"vm10web\",\"compose_yaml\":\"$YAML\"}")
s=$(job_wait "$r" 600); P=$(res_uuid "$r"); save P "$P"
port=$(b "$(api GET "/compose-projects/$P")" '["data"]["ports"][0]["host_port"]')
bind=$(ss -Hltn "( sport = :${port:-0} )" | awk '{print $4}' | head -n1)
SSL=none; [ "${ITSO_VM_ACME:-0}" = 1 ] && SSL=acme
r2=$(api POST /websites "{\"hosting_account_uuid\":\"$ACC\",\"primary_domain\":\"docker.vm10.itso.test\",\"type\":\"docker\",\"ssl_mode\":\"$SSL\",\"docker_target\":{\"compose_project_uuid\":\"$P\",\"service\":\"web\"}}")
s2=$(job_wait "$r2" 600)
hc=$(page_code docker.vm10.itso.test http 80)
if [ "$(st "$bad")" = 422 ] && [ "$s" = succeeded ] && [ "${port:-0}" -ge 20000 ] && [ "${port:-0}" -le 29999 ] \
  && [[ "$bind" == 127.0.0.1:* ]] && [ "$s2" = succeeded ] && [[ "$hc" =~ ^(200|301|302)$ ]]; then
  row V2 "compose thật → cổng → website Docker" "privileged 422; cổng 127.0.0.1:20000–29999; site trả nội dung" PASS "cổng $bind; HTTP $hc; SSL $SSL"
else
  row V2 "compose thật → website Docker" "422 + apply + cổng loopback + HTTP 200" FAIL "bad $(st "$bad"); apply $s; cổng $port bind $bind; site $s2 $(detail "$r2"); HTTP $hc"
fi
[ "$SSL" = acme ] || row V2b "HTTPS cho website Docker" "ITSO_VM_ACME=1 (cần DNS/Pebble)" SKIP "chạy lại với ITSO_VM_ACME=1 khi có DNS công khai hoặc Pebble"

# ---------------------------------------------------------------- V3 image lỗi → quay lại
docker rm -f vm10-registry >/dev/null 2>&1
docker run -d --name vm10-registry -p 127.0.0.1:5000:5000 registry:2 >/dev/null 2>&1
tmp=$(mktemp -d)
mk() { printf 'FROM busybox:1.36\nRUN mkdir /www && echo %s > /www/index.html\nHEALTHCHECK --interval=2s --retries=2 CMD %s\nCMD ["httpd","-f","-p","80","-h","/www"]\n' "$1" "$2" >"$tmp/Dockerfile"
  docker build -q -t localhost:5000/vm10/app:1 "$tmp" >/dev/null && docker push -q localhost:5000/vm10/app:1 >/dev/null; }
v3=""
mk v1-ok true || v3+="build v1 lỗi; "
r=$(api POST /compose-projects "{\"server_uuid\":\"$SRV\",\"name\":\"vm10img\",\"compose_yaml\":\"services:\\n  app:\\n    image: localhost:5000/vm10/app:1\\n    ports:\\n      - \\\"80\\\"\\n\"}")
s=$(job_wait "$r" 600); PI=$(res_uuid "$r")
d1=$(docker inspect --format '{{.Image}}' "$(docker ps -q --filter "label=com.docker.compose.service=app" --filter "label=com.docker.compose.project=itso_$PI" | head -n1)" 2>/dev/null)
mk v2-broken false || v3+="build v2 lỗi; "
docker image rm localhost:5000/vm10/app:1 >/dev/null 2>&1 # để agent phải pull bản mới từ registry
u=$(api POST "/compose-projects/$PI:update-images" '{"services":[]}')
su=$(job_wait "$u" 600)
last=$(b "$(api GET "/compose-projects/$PI")" '["data"]["last_image_update"]["state"]')
d2=$(docker inspect --format '{{.Image}}' "$(docker ps -q --filter "label=com.docker.compose.service=app" --filter "label=com.docker.compose.project=itso_$PI" | head -n1)" 2>/dev/null)
if [ -z "$v3" ] && [ "$s" = succeeded ] && [ "$last" = rolled_back ] && [ -n "$d1" ] && [ "$d1" = "$d2" ]; then
  row V3 "cập nhật image lỗi → quay lại" "rolled_back, container chạy lại image cũ" PASS "job $su; image ${d1:7:12}"
else
  row V3 "cập nhật image lỗi → quay lại" "rolled_back + cùng image cũ" FAIL "$v3 apply $s; update $su; last=$last; ${d1:7:12} → ${d2:7:12}"
fi
rm -rf "$tmp"

# ---------------------------------------------------------------- V4 backup/restore volume
r=$(api POST /compose-projects "{\"server_uuid\":\"$SRV\",\"name\":\"vm10vol\",\"compose_yaml\":\"services:\\n  db:\\n    image: busybox:1.36\\n    command: [\\\"sleep\\\",\\\"86400\\\"]\\n    volumes:\\n      - data:/data\\nvolumes:\\n  data: {}\\n\"}")
s=$(job_wait "$r" 600); PV=$(res_uuid "$r"); VOL="itso_${PV}_data"
docker run --rm -v "$VOL:/d" busybox:1.36 sh -c 'for i in $(seq 1 200); do head -c 4096 /dev/urandom > /d/f$i; done' >/dev/null 2>&1
h1=$(docker run --rm -v "$VOL:/d:ro" busybox:1.36 sh -c 'cd /d && cat $(ls | sort) | sha256sum' 2>/dev/null | cut -c1-64)
dest=$(jget "$(api GET /backup-destinations)" "next((x['uuid'] for x in d['body']['data'] if x['type']=='local'), '')")
if [ -z "$dest" ]; then
  dr=$(api POST /backup-destinations '{"name":"VM10 local","type":"local","config":{"path":"/var/backups/itso"}}'); dest=$(b "$dr" '["data"]["uuid"]')
fi
pol=$(api POST /backup-policies "{\"name\":\"vm10 volume\",\"scope_type\":\"compose_project\",\"scope_uuid\":\"$PV\",\"contents\":[\"docker_volumes\"],\"volume_consistency\":\"pause\",\"schedule\":\"0 3 * * *\",\"destination_uuids\":[\"$dest\"]}")
sb=$(job_wait "$(api POST "/backup-policies/$(b "$pol" '["data"]["uuid"]'):run")" 900)
snap=$(jget "$(api GET '/backup-snapshots?per_page=100')" "next((x['uuid'] for x in d['body']['data'] if 'docker_volumes' in x['contents']), '')")
rr=$(api POST /restores "{\"snapshot_uuid\":\"$snap\",\"mode\":\"new\",\"items\":[\"volume:$VOL\"]}")
sr=$(job_wait "$rr" 900)
NEWV=$(docker volume ls -q | grep "^${VOL}_r" | tail -n1)
h2=$(docker run --rm -v "${NEWV:-none}:/d:ro" busybox:1.36 sh -c 'cd /d && cat $(ls | sort) | sha256sum' 2>/dev/null | cut -c1-64)
if [ "$s" = succeeded ] && [ "$sb" = succeeded ] && [ "$sr" = succeeded ] && [ -n "$h1" ] && [ "$h1" = "$h2" ]; then
  row V4 "backup volume (pause) → khôi phục volume mới" "nội dung giống hệt" PASS "$VOL → $NEWV sha ${h1:0:12}"
else
  row V4 "backup/khôi phục volume" "backup + restore succeeded, sha khớp" FAIL "apply $s; backup $sb; restore $sr $(detail "$rr"); ${h1:0:12} vs ${h2:0:12}"
fi

# ---------------------------------------------------------------- V5 WordPress thật
v5=""
for k in wp-cli mariadb; do
  r=$(api POST "/servers/$SRV/software/$k:install"); [ "$(st "$r")" = 409 ] || [ "$(job_wait "$r" 900)" = succeeded ] || v5+="$k; "
done
dom=wp.vm10.itso.test
r=$(api POST /websites "{\"hosting_account_uuid\":\"$ACC\",\"primary_domain\":\"$dom\",\"type\":\"php\",\"php_version\":\"8.3\",\"ssl_mode\":\"none\"}")
[ "$(job_wait "$r" 300)" = succeeded ] || v5+="website $(detail "$r"); "
W=$(res_uuid "$r")
ir=$(api POST /wordpress/sites "{\"website_uuid\":\"$W\",\"title\":\"VM10\",\"admin_username\":\"vm10admin\",\"admin_email\":\"vm10@example.test\",\"locale\":\"en_US\"}")
secret=$(b "$ir" '["secret"]'); si=$(job_wait "$ir" 900); WP=$(res_uuid "$ir"); save WP "$WP"
leak=$(as_itso $ART tinker --no-interaction --execute "echo DB::table('job_steps')->where('params_redacted','like','%'.base64_decode('$(printf %s "$secret" | base64 -w0)').'%')->count();" 2>/dev/null | tail -n1)
home=$(page_code "$dom")
if [ -z "$v5" ] && [ "$si" = succeeded ] && [ "${#secret}" -ge 16 ] && [ "${leak:-1}" = 0 ] && [ "$home" = 200 ]; then
  row V5a "cài WordPress thật qua panel" "trang chủ 200; mật khẩu chỉ trong response" PASS "WP $WP"
else
  row V5a "cài WordPress thật" "job succeeded + 200 + không lộ mật khẩu" FAIL "$v5 job $si $(detail "$ir"); HTTP $home; leak=$leak"
fi
# Hạ akismet về bản cũ (dưới uid account) rồi chặn tải → cập nhật lỗi giữa chừng → khôi phục snapshot.
root="/home/$ACCN/sites/$dom/public"
as_acct "$ACCN" "itso-acct-$(id -u "$ACCN").slice" /usr/bin/php8.3 /usr/local/lib/itso/wp-cli-2.11.0.phar --path="$root" plugin install akismet --version=5.0 --force --activate >/dev/null 2>&1
before=$(sha256sum "$root/wp-content/plugins/akismet/akismet.php" | cut -c1-64)
artisan itso:wordpress-auto-update --refresh >/dev/null
echo "127.0.0.1 downloads.wordpress.org # itso-vm10" >>/etc/hosts
u=$(api POST "/wordpress/sites/$WP:update" '{"plugins":["akismet"]}')
su=$(job_wait "$u" 1200)
sed -i '/# itso-vm10$/d' /etc/hosts
hist=$(api GET "/wordpress/sites/$WP/updates")
ust=$(b "$hist" '["data"][0]["state"]')
after=$(sha256sum "$root/wp-content/plugins/akismet/akismet.php" 2>/dev/null | cut -c1-64)
if [ "$su" = succeeded ] && [ "$ust" = rolled_back ] && [ "$before" = "$after" ] && [ "$(page_code "$dom")" = 200 ]; then
  row V5b "cập nhật plugin lỗi → rolled_back" "file plugin về như trước; site 200" PASS "$(b "$hist" '["data"][0]["error"]' | cut -c1-120)"
else
  row V5b "cập nhật lỗi → rolled_back" "rolled_back + file như cũ + 200" FAIL "job $su; state $ust; sha ${before:0:12} → ${after:0:12}"
fi
c=$(api POST "/wordpress/sites/$WP:clone-staging" '{"subdomain":"staging"}')
sc=$(job_wait "$c" 1200)
noidx=$(page "staging.$dom" http 80 "/?feed=" | grep -c "noindex" || true)
h=$(api POST "/wordpress/sites/$WP:harden" '{"items":["file_edit_disabled","xmlrpc_blocked","php_in_uploads_blocked","wp_config_protected"],"enabled":true}')
sh=$(job_wait "$h" 600)
mkdir -p "$root/wp-content/uploads"; echo '<?php echo "pwned";' >"$root/wp-content/uploads/x.php"; chown -R "$ACCN:$ACCN" "$root/wp-content/uploads"
xr=$(page_code "$dom" http 80 /xmlrpc.php); up=$(page_code "$dom" http 80 /wp-content/uploads/x.php)
cfg=$(stat -c %a "$root/wp-config.php")
if [ "$sc" = succeeded ] && [ "$(page_code "staging.$dom")" = 200 ] && [ "$sh" = succeeded ] && [ "$xr" = 403 ] && [ "$up" = 403 ] && [ "$cfg" = 400 ]; then
  row V5c "staging + harden" "staging 200 (noindex); xmlrpc 403; PHP uploads 403; wp-config 0400" PASS "noindex meta: $noidx"
else
  row V5c "staging + harden" "staging + 403 + 0400" FAIL "clone $sc $(detail "$c"); harden $sh; xmlrpc $xr; uploads $up; wp-config $cfg"
fi

echo "Bước tiếp V1: trên máy ngoài chạy  bash tests/vm/phase10.sh --probe $(hostname -I | awk '{print $1}') 18080 closed" >&2
[ "$FAIL" -eq 0 ]
