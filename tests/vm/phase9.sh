#!/usr/bin/env bash
# Bộ test VM Phase 9 (nhiều máy chủ: relay mTLS, node, chuyển account) — 3 VM Ubuntu 24.04 dùng một lần.
# KHÔNG chạy trên máy thật: script đổi nftables, tạo/xóa account thử, thu hồi node.
#
#   VM P  (control plane, đã cài all-in-one ≥ 0.9 qua run-all.sh --no-uninstall), VM N1, VM N2 (Ubuntu sạch).
#
#   1. P : sudo bash tests/vm/phase9.sh --prepare vm9-n1 vm9-n2
#          → tạo 2 token join (60 phút), ghi /root/itso-vm9/join-<tên>.sh; chép mỗi file sang node tương ứng.
#   2. N1, N2: sudo bash join-<tên>.sh            (install.sh --role node --join … --token … --ca-sha256 …)
#   3. N1, N2: sudo bash tests/vm/phase9.sh --node --panel-ip <IP P>                         (N1 trên từng node)
#   4. P : sudo bash tests/vm/phase9.sh --panel-1                (N0 3 server online, N3 xoay chứng chỉ, tạo account
#          WordPress thử trên vm9-n1) → in lệnh --seed-wp cho N1
#   5. N1: sudo bash tests/vm/phase9.sh --seed-wp …              (tải WordPress, cài qua install.php, 2 GB uploads)
#   6. P : sudo bash tests/vm/phase9.sh --panel-2                (N4 chuyển n1 → n2, N5 rollback sau cutover,
#          N2 mất mạng node → waiting_agent / quá hạn, N6 thu hồi node)
#
# Panel được gọi trong tiến trình (artisan tinker + lib/panel_api.php: khớp route → controller với user Super Admin,
# bỏ qua middleware phiên/MFA vì không có người); validate, phạm vi, job, audit vẫn như khi gọi qua HTTP.
#   N0 3 server (P + 2 node) online qua relay, chứng chỉ mTLS
#   N1 node không có cổng quản trị inbound: itso-agent-node không nghe TCP; chỉ kết nối RA tới P:28444 (ss)
#   N2 chặn node ở P (nftables) → job mới chờ node (waiting_agent) → mở lại chạy tiếp; job quá hạn → agent_unreachable
#   N3 itso:certs-rotate --force → fingerprint mới, node vẫn online
#   N4 chuyển account WordPress + DB (≥ 2 GB) n1 → n2: kiểm chứng (checksum file/DB ở đích) + HTTP 200 cùng nội dung
#      từ n2; downtime cutover ≤ 300 s
#   N5 rollback sau cutover → account về n1, site 200 từ n1
#   N6 thu hồi node n2 → relay từ chối (không còn kết nối, job mới lỗi/không gửi được)
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

REPORT="${REPORT:-/root/itso-vm-phase9.md}"
ST=/root/itso-vm9
MODE=""
ARGS=()
PANEL_IP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT="$2"; shift 2 ;;
    --prepare|--node|--panel-1|--panel-2|--seed-wp) MODE="${1#--}"; shift ;;
    --panel-ip) PANEL_IP="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[ -n "$MODE" ] || { sed -n 2,28p "$0"; exit 2; }
[ "$(id -u)" = 0 ] || { echo "cần root (VM test)" >&2; exit 2; }
trap 'cleanup; write_report' EXIT

ART="frankenphp php-cli /opt/itso/current/api/artisan"
LIB=/tmp/itso-vm9-panel_api.php
NFT=no

cleanup() {
  [ "$NFT" = yes ] && nft delete table inet itso_vm9 2>/dev/null
  return 0
}

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
job_state() { b "$(api GET "/jobs/$1")" '["data"]["state"]'; }
job_wait() { # job_wait <uuid> [giây] → trạng thái cuối
  local s="" i
  for i in $(seq 1 "${2:-600}"); do
    s=$(job_state "$1")
    case "$s" in succeeded|failed|cancelled|timed_out) break ;; esac
    [ $((i % 10)) = 0 ] && artisan itso:relay-sync >/dev/null
    sleep 1
  done
  echo "$s"
}
server_of() { # server_of <tên> → JSON server
  local r; r=$(api GET "/servers?per_page=100")
  jget "$r" "json.dumps(next((s for s in d['body']['data'] if s['name']=='$1'), {}))"
}
mig_of() { # mig_of <account uuid> → JSON lượt chuyển mới nhất
  local r; r=$(api GET /account-migrations)
  jget "$r" "json.dumps(next((m for m in d['body']['data'] if m['hosting_account']['uuid']=='$1'), {}))"
}
mig_wait() { # mig_wait <account uuid> <trạng thái regex> [giây]
  local m s i
  for i in $(seq 1 "${3:-3600}"); do
    m=$(mig_of "$1"); s=$(jget "$m" 'd.get("state","")')
    [[ "$s" =~ ^($2)$ ]] && { echo "$m"; return 0; }
    [ "$s" = failed ] && { echo "$m"; return 1; }
    [ $((i % 15)) = 0 ] && artisan itso:relay-sync >/dev/null
    sleep 1
  done
  echo "$m"; return 1
}
save() { mkdir -p "$ST"; printf '%s=%q\n' "$1" "$2" >>"$ST/state.env"; }
# shellcheck disable=SC1091
load() { [ -f "$ST/state.env" ] && . "$ST/state.env"; }
page_hash() { curl -s --max-time 20 -H "Host: $1" "http://$2/" | sha256sum | cut -c1-64; }
page_code() { curl -s -o /dev/null --max-time 20 -w '%{http_code}' -H "Host: $1" "http://$2/"; }

N1N=vm9-n1
N2N=vm9-n2

# ================================================================ --prepare (P)
if [ "$MODE" = prepare ]; then
  N1N="${ARGS[0]:-$N1N}"; N2N="${ARGS[1]:-$N2N}"
  mkdir -p "$ST" && chmod 0700 "$ST" && : >"$ST/state.env"
  save N1N "$N1N"; save N2N "$N2N"
  systemctl is-active --quiet itso-relay || { itso pki init >/dev/null 2>&1; systemctl enable --now itso-relay >/dev/null 2>&1; }
  for n in "$N1N" "$N2N"; do
    r=$(api POST /servers/enrollment-tokens "{\"name\":\"$n\",\"role_tags\":[\"web\",\"db\"],\"ttl_min\":60}")
    if [ "$(st "$r")" = 201 ]; then
      { echo '#!/usr/bin/env bash'; echo "# Join $n vào control plane (token dùng một lần, hết hạn $(b "$r" '["data"]["expires_at"]'))"
        echo "set -e"; b "$r" '["data"]["command"]'; } >"$ST/join-$n.sh"
      chmod 0600 "$ST/join-$n.sh"
      row P0 "token join $n" "201, lệnh có --ca-sha256" PASS "$ST/join-$n.sh (pin $(b "$r" '["data"]["ca_sha256"]' | cut -c1-12)…)"
    else
      row P0 "token join $n" "201" FAIL "$(st "$r") $(b "$r" '.get("detail")')"
    fi
  done
  [ "$FAIL" -eq 0 ]; exit
fi

# ================================================================ --node (N1, trên từng node)
if [ "$MODE" = node ]; then
  [ -n "$PANEL_IP" ] || { echo "cần --panel-ip <IP control plane>" >&2; exit 2; }
  pid=$(systemctl show -p MainPID --value itso-agent-node)
  tcp_listen=$(ss -Hltnp 2>/dev/null | grep -c "pid=$pid," || true)
  est=$(ss -Htnp state established "( dport = :28444 )" 2>/dev/null | grep -c "$PANEL_IP" || true)
  others=$(ss -Hltn 2>/dev/null | awk '{print $4}' | grep -vE ':(22|80|443|53)$' | grep -vE '^(127\.|\[::1\])' | tr '\n' ' ')
  st_out=$(itso node status 2>&1 | tail -n 8 | tr '\n' ' ')
  if [ "$pid" != 0 ] && [ "$tcp_listen" = 0 ] && [ "${est:-0}" -ge 1 ] && [ -z "$others" ]; then
    row N1 "node không có cổng quản trị inbound" "agent không nghe TCP; kết nối ra $PANEL_IP:28444" PASS "pid $pid; established $est; $st_out"
  else
    row N1 "node không có cổng quản trị inbound" "agent không nghe TCP; chỉ kết nối ra" FAIL "pid=$pid listen=$tcp_listen established=$est cổng lạ: $others"
  fi
  if command -v nmap >/dev/null; then
    row N1b "nmap từ chính node (giao diện ngoài)" "chỉ 22/80/443" WARN "$(nmap -Pn -p- --open "$(hostname -I | awk '{print $1}')" 2>/dev/null | grep -E '^[0-9]+/tcp' | tr '\n' ' ')"
  fi
  [ "$FAIL" -eq 0 ]; exit
fi

# ================================================================ --seed-wp (N1): WordPress + dữ liệu lớn
if [ "$MODE" = seed-wp ]; then
  U="${ARGS[0]}"; DOM="${ARGS[1]}"; DBN="${ARGS[2]}"; DBP="${ARGS[3]}"; MB="${ARGS[4]:-2048}"
  ROOT="/home/$U/sites/$DOM/public"
  [ -d "$ROOT" ] || { echo "không thấy $ROOT (chạy --panel-1 trước)" >&2; exit 2; }
  tmp=$(mktemp -d)
  if curl -fsSL --max-time 300 -o "$tmp/wp.tgz" https://wordpress.org/latest.tar.gz && tar -C "$tmp" -xzf "$tmp/wp.tgz"; then
    cp -a "$tmp/wordpress/." "$ROOT/"
    sed -e "s/database_name_here/$DBN/" -e "s/username_here/$DBN/" -e "s/password_here/$DBP/" \
      "$ROOT/wp-config-sample.php" >"$ROOT/wp-config.php"
    mkdir -p "$ROOT/wp-content/uploads/vm9"
    # Dữ liệu lớn: file ngẫu nhiên 64 MiB (không nén được) tới MB.
    for i in $(seq 1 $((MB / 64))); do head -c $((64 << 20)) /dev/urandom >"$ROOT/wp-content/uploads/vm9/blob-$i.bin"; done
    chown -R "$U:$U" "/home/$U/sites/$DOM"
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $DOM" --data-urlencode "weblog_title=VM9 $DOM" \
      --data-urlencode "user_name=vm9admin" --data-urlencode "admin_password=$(head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9)" \
      --data-urlencode "admin_password2=x" --data-urlencode "pw_weak=1" --data-urlencode "admin_email=vm9@example.test" \
      --data-urlencode "blog_public=0" "http://127.0.0.1/wp-admin/install.php?step=2")
    home=$(page_code "$DOM" 127.0.0.1)
    size=$(du -sm "/home/$U/sites/$DOM" | cut -f1)
    if [ "$home" = 200 ]; then
      row S0 "WordPress + ${MB} MB trên $(hostname)" "install.php xong, trang chủ 200" PASS "install HTTP $code; site ${size} MB"
    else
      row S0 "WordPress trên $(hostname)" "trang chủ 200" FAIL "install HTTP $code; trang chủ $home"
    fi
  else
    row S0 "tải WordPress" "wordpress.org/latest.tar.gz" FAIL "không tải/giải nén được"
  fi
  rm -rf "$tmp"
  [ "$FAIL" -eq 0 ]; exit
fi

load
[ -n "${N1N:-}" ] || { echo "chưa có $ST/state.env (chạy --prepare trước)" >&2; exit 2; }

# ================================================================ --panel-1 (P): N0, N3, account thử
if [ "$MODE" = panel-1 ]; then
  artisan itso:relay-sync >/dev/null
  r=$(api GET "/servers?per_page=100")
  online=$(jget "$r" "sum(1 for s in d['body']['data'] if s.get('connection')=='online')")
  names=$(jget "$r" "' '.join(s['name']+':'+str(s.get('connection')) for s in d['body']['data'])")
  if [ "${online:-0}" -ge 3 ] && [[ "$names" == *"$N1N:online"* ]] && [[ "$names" == *"$N2N:online"* ]]; then
    row N0 "quản lý 3 server (P + 2 node qua relay)" "3 server online" PASS "$names"
  else
    row N0 "quản lý 3 server" "3 server online" FAIL "$names"
  fi
  # N3: xoay chứng chỉ (hai pha: CSR trên node → CA ký → cài) rồi node vẫn online.
  fp1=$(jget "$(server_of "$N1N")" 'd["cert"]["fingerprint_sha256"]')
  out=$(artisan itso:certs-rotate --force | tail -n 3 | tr '\n' ' ')
  sleep 5; artisan itso:relay-sync >/dev/null
  s1=$(server_of "$N1N")
  fp2=$(jget "$s1" 'd["cert"]["fingerprint_sha256"]')
  if [ -n "$fp1" ] && [ -n "$fp2" ] && [ "$fp1" != "$fp2" ] && [ "$(jget "$s1" 'd["connection"]')" = online ]; then
    row N3 "xoay chứng chỉ node" "fingerprint mới, node online" PASS "${fp1:0:12}… → ${fp2:0:12}… · $out"
  else
    row N3 "xoay chứng chỉ node" "fingerprint mới, node online" FAIL "fp ${fp1:0:12} → ${fp2:0:12}; $(jget "$s1" 'd.get("connection")'); $out"
  fi
  # Account WordPress thử trên n1: user portal + gói đầu tiên + website PHP + DB có user.
  n1=$(jget "$(server_of "$N1N")" 'd["uuid"]')
  U="wp$(date +%H%M%S | cut -c1-6)"; DOM="$U.vm9.itso.test"
  ow=$(api POST /users "{\"realm\":\"portal\",\"name\":\"VM9 $U\",\"email\":\"$U@vm9.itso.test\",\"role\":\"USER\",\"send_invite\":false}")
  owu=$(b "$ow" '["data"]["uuid"]')
  pk=$(b "$(api GET '/hosting-packages?per_page=10')" '["data"][0]["uuid"]')
  ac=$(api POST /hosting-accounts "{\"owner_user_uuid\":\"$owu\",\"package_uuid\":\"$pk\",\"server_uuid\":\"$n1\",\"username\":\"$U\",\"primary_domain\":null}")
  AUUID=$(b "$ac" '["resource"]["uuid"]'); s_ac=$(job_wait "$(b "$ac" '["job"]["uuid"]')")
  ws=$(api POST /websites "{\"hosting_account_uuid\":\"$AUUID\",\"primary_domain\":\"$DOM\",\"type\":\"php\",\"ssl_mode\":\"none\"}")
  s_ws=$(job_wait "$(b "$ws" '["job"]["uuid"]')")
  db=$(api POST /databases "{\"hosting_account_uuid\":\"$AUUID\",\"engine\":\"mariadb\",\"name\":\"${U}_wp\",\"create_user\":true}")
  s_db=$(job_wait "$(b "$db" '["job"]["uuid"]')"); DBP=$(b "$db" '["secret"]')
  if [ "$s_ac/$s_ws/$s_db" = succeeded/succeeded/succeeded ]; then
    save AUUID "$AUUID"; save U "$U"; save DOM "$DOM"
    row P1 "account WordPress thử trên $N1N" "account + website PHP + DB" PASS \
      "trên $N1N chạy: sudo bash tests/vm/phase9.sh --seed-wp $U $DOM ${U}_wp '$DBP' 2048"
    echo "== Trên $N1N: sudo bash tests/vm/phase9.sh --seed-wp $U $DOM ${U}_wp '$DBP' 2048" >&2
  else
    row P1 "account thử trên $N1N" "3 job succeeded" FAIL "account=$s_ac website=$s_ws db=$s_db $(b "$ac" '.get("detail")')"
  fi
  [ "$FAIL" -eq 0 ]; exit
fi

# ================================================================ --panel-2 (P): N4, N5, N2, N6
[ "$MODE" = panel-2 ] || { echo "chế độ lạ: $MODE" >&2; exit 2; }
[ -n "${AUUID:-}" ] || { echo "chưa có account thử (chạy --panel-1 rồi --seed-wp)" >&2; exit 2; }
s1=$(server_of "$N1N"); s2=$(server_of "$N2N")
n1=$(jget "$s1" 'd["uuid"]'); n2=$(jget "$s2" 'd["uuid"]')
ip1=$(jget "$s1" 'd["ip_addresses"][0]'); ip2=$(jget "$s2" 'd["ip_addresses"][0]')

# N4: chuyển n1 → n2.
before=$(page_hash "$DOM" "$ip1"); code1=$(page_code "$DOM" "$ip1")
pf=$(api POST "/hosting-accounts/$AUUID:migrate-preflight" "{\"target_server_uuid\":\"$n2\"}")
pf_ok=$(b "$pf" '["data"]["ok"]'); est=$(b "$pf" '["data"]["estimate"]')
mg=$(api POST "/hosting-accounts/$AUUID:migrate" "{\"target_server_uuid\":\"$n2\",\"keep_source_days\":3}")
t0=$(date +%s)
if [ "$pf_ok" = True ] && [ "$(st "$mg")" = 202 ] && m=$(mig_wait "$AUUID" verifying 7200); then
  sync_s=$(($(date +%s) - t0))
  bad=$(jget "$m" "', '.join(c['kind']+':'+c['name'] for c in d['verification'] if not c['ok'])")
  MUUID=$(jget "$m" 'd["uuid"]')
  cu=$(api POST "/account-migrations/$MUUID:cutover" '{}')
  if [ -z "$bad" ] && [ "$(st "$cu")" = 202 ] && m=$(mig_wait "$AUUID" holding 1800); then
    dt=$(jget "$m" 'd["downtime_sec"]'); after=$(page_hash "$DOM" "$ip2"); code2=$(page_code "$DOM" "$ip2")
    srv=$(b "$(api GET "/hosting-accounts/$AUUID")" '["data"]["server"]["name"]')
    if [ "$srv" = "$N2N" ] && [ "$code2" = 200 ] && [ "$after" = "$before" ] && [ "${dt:-999}" -le 300 ]; then
      row N4 "chuyển WordPress + DB (≥ 2 GB) $N1N → $N2N" "kiểm chứng khớp; 200 cùng nội dung từ đích; downtime ≤ 300 s" PASS \
        "đồng bộ ${sync_s} s; downtime ${dt} s; HTTP $code1→$code2; ước lượng $est"
    else
      row N4 "chuyển $N1N → $N2N" "site ở đích, downtime ≤ 300 s" FAIL "server=$srv HTTP $code2 hash ${before:0:8}/${after:0:8} downtime=$dt"
    fi
  else
    row N4 "chuyển $N1N → $N2N" "kiểm chứng khớp → cutover → holding" FAIL "lệch: $bad; cutover=$(st "$cu") $(jget "$m" 'd.get("state","")+" "+str(d.get("error"))')"
  fi
else
  row N4 "chuyển $N1N → $N2N" "preflight ok → verifying" FAIL "preflight=$pf_ok migrate=$(st "$mg") $(b "$mg" '.get("detail")') $(jget "${m:-{\}}" 'str(d.get("error"))')"
fi

# N5: rollback sau cutover → account về n1.
if [ -n "${MUUID:-}" ]; then
  rb=$(api POST "/account-migrations/$MUUID:rollback" '{}')
  m=$(mig_wait "$AUUID" rolled_back 1800)
  srv=$(b "$(api GET "/hosting-accounts/$AUUID")" '["data"]["server"]["name"]')
  code=$(page_code "$DOM" "$ip1"); h=$(page_hash "$DOM" "$ip1")
  if [ "$(st "$rb")" = 202 ] && [ "$(jget "$m" 'd["state"]')" = rolled_back ] && [ "$srv" = "$N1N" ] && [ "$code" = 200 ] && [ "$h" = "$before" ]; then
    row N5 "rollback sau cutover" "account về $N1N, site 200 cùng nội dung" PASS "HTTP $code từ $ip1"
  else
    row N5 "rollback sau cutover" "account về $N1N" FAIL "rollback=$(st "$rb") state=$(jget "$m" 'd.get("state")') server=$srv HTTP $code"
  fi
else
  row N5 "rollback sau cutover" "cần N4" SKIP "N4 không tới cutover"
fi

# N2: chặn n2 ở P (nftables: rớt gói từ n2 tới 28444, cắt kết nối đang có) → waiting_agent → mở lại chạy tiếp.
nft add table inet itso_vm9 && nft add chain inet itso_vm9 in '{ type filter hook input priority -10 ; }' \
  && nft add rule inet itso_vm9 in ip saddr "$ip2" tcp dport 28444 drop && NFT=yes
conntrack -D -s "$ip2" >/dev/null 2>&1 || ss -K dst "$ip2" >/dev/null 2>&1
sleep 20; artisan itso:relay-sync >/dev/null
j=$(api POST "/servers/$n2/services/nginx:restart" '{}'); ju=$(b "$j" '["job"]["uuid"]')
sleep 5; w1=$(job_state "$ju")
j2=$(api POST "/servers/$n2/services/cron:restart" '{}'); ju2=$(b "$j2" '["job"]["uuid"]')
# Rút hạn chờ của job thứ hai xuống 30 s để thấy quá hạn → agent_unreachable (hạn mặc định 30 phút).
artisan tinker --execute "App\Models\Job::query()->where('uuid','$ju2')->update(['agent_deadline_at'=>now()->addSeconds(30)]);" >/dev/null
sleep 45; artisan itso:relay-sync >/dev/null
f2=$(job_wait "$ju2" 120); e2=$(b "$(api GET "/jobs/$ju2")" '["data"].get("error_code")')
nft delete table inet itso_vm9 2>/dev/null; NFT=no
f1=$(job_wait "$ju" 300)
if [ "$w1" = waiting_agent ] && [ "$f1" = succeeded ] && [ "$f2" = failed ] && [ "$e2" = agent_unreachable ]; then
  row N2 "mất mạng node → job chờ / quá hạn" "waiting_agent → succeeded khi nối lại; quá hạn → agent_unreachable" PASS "job1 $w1→$f1; job2 $f2 ($e2)"
else
  row N2 "mất mạng node" "waiting_agent → succeeded; quá hạn → agent_unreachable" FAIL "job1 $w1→$f1; job2 $f2 ($e2)"
fi

# N6: thu hồi n2 (không còn account) → relay từ chối.
rv=$(api POST "/servers/$n2:revoke" "{\"confirm_name\":\"$N2N\"}")
sleep 10; artisan itso:relay-sync >/dev/null
conn=$(jget "$(server_of "$N2N")" 'd["connection"]')
j3=$(api POST "/servers/$n2/services/nginx:reload" '{}')
f3=$([ "$(st "$j3")" = 202 ] && job_wait "$(b "$j3" '["job"]["uuid"]')" 120 || echo "refused-$(st "$j3")")
if [ "$(st "$rv")" = 200 ] && [ "$conn" = revoked ] && [ "$f3" != succeeded ]; then
  row N6 "thu hồi node" "connection revoked; job mới không chạy được" PASS "job mới: $f3; journal relay: $(journalctl -u itso-relay -n 50 --no-pager 2>/dev/null | grep -ci revok) dòng revoke"
else
  row N6 "thu hồi node" "revoked; relay từ chối" FAIL "revoke=$(st "$rv") $(b "$rv" '.get("detail")') connection=$conn job=$f3"
fi
[ "$FAIL" -eq 0 ]
