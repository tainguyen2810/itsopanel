#!/usr/bin/env bash
# Bộ test VM Phase 7 (Security Center) — chạy bằng root trong VM Ubuntu 24.04 ĐÃ CÀI ITSO
# (sau run-all.sh --no-uninstall), dùng một lần. KHÔNG chạy trên máy thật: script đổi tường lửa, sshd, fail2ban.
#
#   sudo bash tests/vm/phase7.sh [--report /root/itso-vm-phase7.md] [--client-ip <IP máy đang SSH vào>]
#
# Gọi agent thật qua socket (ký HMAC, lib/agent_call.py) như Laravel làm:
#   S0 cài fail2ban, clamav, yara, modsecurity, nginx qua recipe; security.audit thấy đủ gói
#   S1 safe-apply: firewall + sshd áp dụng rồi DỪNG agent (mất kết nối panel/agent) → timer systemd tự hoàn tác
#      đúng hạn; áp dụng + xác nhận thì giữ; token sai bị từ chối
#   S2 fail2ban chặn thật: SSH sai user từ IP phụ → bị ban trong nftables → unban gỡ được
#   S3 WAF: payload OWASP (SQLi, XSS, traversal) bị chặn 403 khi On, chỉ ghi nhận khi DetectionOnly; waf.events
#      gán đúng website
#   S4 EICAR: quét dưới uid account (slice, Nice 19) tìm thấy; site vẫn trả 200 trong lúc quét; cách ly → khôi phục
#   S5 FIM: baseline → thêm file /usr/local/bin, sửa /etc/ssh, setuid → fim.check báo đúng loại thay đổi
#   S6 điểm bảo mật mặc định sau cài ≥ 80 (artisan itso:security-audit, đọc security_settings)
#   S7 terminal root theo policy: tắt → op_disabled; bật (itso policy set) → shell uid 0 + bản ghi 0600; tắt lại
# Dọn dẹp ở cuối: tường lửa về cấu hình nền đã xác nhận, gỡ WAF + vhost + site, file thử, IP phụ.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

REPORT="${REPORT:-/root/itso-vm-phase7.md}"
CLIENT_IP="${SSH_CLIENT%% *}"
while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT="$2"; shift 2 ;;
    --client-ip) CLIENT_IP="$2"; shift 2 ;;
    *) echo "tham số lạ: $1" >&2; exit 2 ;;
  esac
done
CLIENT_IP="${CLIENT_IP:-10.0.2.2}"
[ "$(id -u)" = 0 ] || { echo "cần root (VM test)" >&2; exit 2; }
[ -S /run/itso/agent.sock ] || { echo "chưa có itso-agent (chạy run-all.sh --no-uninstall trước)" >&2; exit 2; }
trap write_report EXIT

LIMITS='{"disk_mb":3000,"inode_limit":50000,"cpu_percent":100,"ram_mb":512,"tasks_max":128,"io_weight":100,"io_read_bps":null,"io_write_bps":null}'
ok() { [ "$(jget "$1" 'd["body"]["ok"]')" = True ]; }
err() { jget "$1" 'd["body"]["error"]["code"] + ": " + d["body"]["error"]["message"][:160]'; }
code() { jget "$1" 'd["body"].get("error",{}).get("code","ok")'; }
data() { jget "$1" "d['body']['data']$2"; }
uuid() { cat /proc/sys/kernel/random/uuid; }
acct() { echo "{\"username\":\"$1\",\"uid\":$2}"; }
wait_agent() { for _ in $(seq 1 30); do [ -S /run/itso/agent.sock ] && agent system.ping '{}' >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
A=itsog; AU=20301; AJ=$(acct $A $AU)
SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')
SSH_PORT="${SSH_PORT:-22}"
PANEL_PORT="${ITSO_PANEL_PORT:-8443}"
EICAR='X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

# ---------------------------------------------------------------- S0 phần mềm + account
s0=""
for r in nginx fail2ban clamav yara modsecurity; do
  res=$(agent software.install "{\"recipe\":\"$r\"}")
  ok "$res" || s0+="$r: $(err "$res"); "
done
res=$(agent account.ensure "{\"account\":$AJ,\"home_path\":\"/home/$A\",\"shell\":\"/usr/sbin/nologin\",\"limits\":$LIMITS}")
ok "$res" || s0+="account: $(err "$res"); "
aud=$(agent security.audit '{}')
pk=$(data "$aud" '["packages"]')
if [ -z "$s0" ] && ok "$aud" && [[ "$pk" != *False* ]]; then
  row S0 "Cài fail2ban, clamav, yara, modsecurity, nginx; account thử" "security.audit thấy đủ gói" PASS "$pk; $(fail2ban-client --version 2>&1 | head -n1); $(clamdscan --version 2>&1 | cut -c1-40); yara $(yara --version 2>&1)"
else
  row S0 "Cài phần mềm bảo mật" "ok" FAIL "${s0}audit: $(ok "$aud" && echo "$pk" || err "$aud")"
fi

# ---------------------------------------------------------------- S1 safe-apply: mất kết nối → tự hoàn tác
WEB='{"priority":100,"action":"accept","direction":"in","protocol":"tcp","ports":"80,443","source":"0.0.0.0/0","comment":"web"}'
TEST='{"priority":200,"action":"accept","direction":"in","protocol":"tcp","ports":"18181","source":"10.99.0.0/16","comment":"itso-vm-s1"}'
AL="{\"ssh_port\":$SSH_PORT,\"panel_port\":$PANEL_PORT,\"client_ip\":\"$CLIENT_IP\"}"
fw_apply() { agent firewall.apply "{\"apply_id\":\"$1\",\"rules\":$2,\"anti_lockout\":$AL,\"confirm_within_sec\":$3}"; }
# 1) Cấu hình nền đã xác nhận (chỉ cổng web).
B1=$(uuid)
res=$(fw_apply "$B1" "[$WEB]" 60)
base_ok=no
if ok "$res"; then
  c=$(agent firewall.confirm "{\"apply_id\":\"$B1\",\"token\":\"$(data "$res" '["token"]')\"}")
  ok "$c" && base_ok=yes
fi
base_sum=$(nft list table inet itso 2>/dev/null | sha256sum | cut -c1-16)
# 2) Thêm rule thử, token sai bị từ chối, rồi dừng agent (panel/agent mất kết nối) — timer phải tự hoàn tác.
P1=$(uuid)
res=$(fw_apply "$P1" "[$WEB,$TEST]" 30)
bad=$(agent firewall.confirm "{\"apply_id\":\"$P1\",\"token\":\"$(printf 'x%.0s' {1..43})\"}")
has_rule=$(nft list table inet itso 2>/dev/null | grep -c 18181)
# sshd cùng lúc: MaxAuthTries 2 (giá trị lạ để nhận ra), không xác nhận.
P2=$(uuid)
mat_before=$(sshd -T 2>/dev/null | awk '/^maxauthtries /{print $2}')
sres=$(agent sshd.config.apply "{\"apply_id\":\"$P2\",\"port\":$SSH_PORT,\"password_authentication\":true,\"permit_root_login\":\"prohibit-password\",\"max_auth_tries\":2,\"login_grace_sec\":60,\"x11_forwarding\":false,\"agent_forwarding\":false,\"allow_groups\":[],\"admin_user\":\"root\",\"client_ip\":\"$CLIENT_IP\",\"confirm_within_sec\":30}")
mat_pending=$(sshd -T 2>/dev/null | awk '/^maxauthtries /{print $2}')
t0=$(date +%s)
systemctl stop itso-agent
sleep 45
after_rule=$(nft list table inet itso 2>/dev/null | grep -c 18181)
after_sum=$(nft list table inet itso 2>/dev/null | sha256sum | cut -c1-16)
mat_after=$(sshd -T 2>/dev/null | awk '/^maxauthtries /{print $2}')
sshd_alive=$(systemctl is-active ssh 2>/dev/null)
systemctl start itso-agent
wait_agent
st=$(agent firewall.status '{}')
dt=$(($(date +%s) - t0))
if [ "$base_ok" = yes ] && ok "$res" && ! ok "$bad" && [ "$has_rule" -ge 1 ] && [ "$after_rule" = 0 ] && [ "$after_sum" = "$base_sum" ] \
  && ok "$sres" && [ "$mat_pending" = 2 ] && [ "$mat_after" = "$mat_before" ] && [ "$sshd_alive" = active ] \
  && [ "$(data "$st" '["state"]')" = rolled_back ]; then
  row S1 "Safe-apply firewall + sshd, agent dừng giữa chừng" "timer systemd tự hoàn tác ≤ 45 s, ruleset về bản đã xác nhận, sshd vẫn chạy" PASS "token sai: $(code "$bad"); ruleset ${base_sum}→(rule thử)→${after_sum}; MaxAuthTries $mat_before→$mat_pending→$mat_after; status=$(data "$st" '["state"]') sau ${dt} s"
else
  row S1 "Safe-apply tự hoàn tác" "rolled_back" FAIL "base=$base_ok apply=$(code "$res") bad=$(code "$bad") rule $has_rule→$after_rule sum $base_sum/$after_sum sshd=$(code "$sres") MaxAuthTries $mat_before/$mat_pending/$mat_after ssh=$sshd_alive status=$(data "$st" '["state"]')"
fi

# ---------------------------------------------------------------- S2 fail2ban chặn thật
IP2=10.250.0.2
ip link add itsof2b type dummy 2>/dev/null
ip addr add 10.250.0.1/32 dev itsof2b 2>/dev/null
ip addr add "$IP2/32" dev itsof2b 2>/dev/null
ip link set itsof2b up
JAILS='[{"name":"sshd","enabled":true,"bantime_sec":600,"findtime_sec":600,"maxretry":3},{"name":"itso-panel","enabled":true,"bantime_sec":600,"findtime_sec":600,"maxretry":5},{"name":"pure-ftpd","enabled":false,"bantime_sec":600,"findtime_sec":600,"maxretry":5}]'
f2b=$(agent fail2ban.apply "{\"enabled\":true,\"jails\":$JAILS,\"ignoreip\":[\"$CLIENT_IP/32\"]}")
sleep 3
KEY=$(mktemp -u)
ssh-keygen -q -t ed25519 -N '' -f "$KEY"
for i in 1 2 3 4 5; do
  timeout 10 ssh -b "$IP2" -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 -p "$SSH_PORT" "itso-nouser-$i@10.250.0.1" true >/dev/null 2>&1
done
banned=no
for _ in $(seq 1 20); do
  fail2ban-client status sshd 2>/dev/null | grep -q "$IP2" && { banned=yes; break; }
  sleep 1
done
blocked=$(timeout 6 ssh -b "$IP2" -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=4 -p "$SSH_PORT" root@10.250.0.1 true 2>&1 | grep -ciE 'timed out|refused|reset')
fst=$(agent fail2ban.status '{}')
in_status=$(jget "$fst" "any(b['ip']=='$IP2' for j in d['body']['data']['jails'] for b in j['banned'])")
unb=$(agent fail2ban.unban "{\"jail\":\"sshd\",\"ip\":\"$IP2\"}")
still=$(fail2ban-client status sshd 2>/dev/null | grep -c "$IP2")
if ok "$f2b" && [ "$banned" = yes ] && [ "$blocked" -ge 1 ] && [ "$in_status" = True ] && ok "$unb" && [ "$still" = 0 ]; then
  row S2 "fail2ban chặn SSH sai user từ IP phụ" "bị ban sau 3 lần, kết nối bị chặn, unban gỡ được" PASS "jails_active=$(data "$f2b" '["jails_active"]'); $IP2 bị ban, SSH lại: bị chặn; unbanned=$(data "$unb" '["unbanned"]')"
else
  row S2 "fail2ban chặn thật" "ban + unban" FAIL "apply=$(code "$f2b") banned=$banned blocked=$blocked status=$in_status unban=$(code "$unb") còn=$still"
fi
rm -f "$KEY" "$KEY.pub"
ip link del itsof2b 2>/dev/null

# ---------------------------------------------------------------- S3 WAF chặn payload OWASP
SITE=$(uuid)
DOM=waf.vm7.itso.test
agent fs.site_layout.ensure "{\"account\":$AJ,\"site_dir\":\"$DOM\"}" >/dev/null
echo "ok" >"/home/$A/sites/$DOM/public/index.html"
chown "$A:$A" "/home/$A/sites/$DOM/public/index.html"
vh=$(agent nginx.vhost.apply "{\"account\":$AJ,\"website_uuid\":\"$SITE\",\"site_dir\":\"$DOM\",\"type\":\"static\",\"server_names\":[\"$DOM\"],\"document_root\":\"public\",\"php_socket\":null,\"tls\":null,\"client_max_body_size\":\"16m\",\"extra_headers\":{},\"suspended\":false,\"redirect_names\":[],\"http2\":true,\"proxy_port\":null,\"redirects\":[]}")
waf() { agent waf.apply "{\"website_uuid\":\"$SITE\",\"account\":$AJ,\"mode\":\"$1\",\"paranoia_level\":1,\"rule_exclusions\":[]}"; }
hit() { curl -s -o /dev/null -w '%{http_code}' -H "Host: $DOM" "http://127.0.0.1$1"; }
PAY=("/?id=1%27%20OR%201%3D1--" "/?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E" "/?f=..%2F..%2F..%2Fetc%2Fpasswd")
cur=$(agent waf.events '{"cursor":null,"limit":1}')
CUR=$(data "$cur" '["next_cursor"]')
w_on=$(waf On)
on_codes=""; for p in "${PAY[@]}"; do on_codes+="$(hit "$p") "; done
clean_on=$(hit /)
w_det=$(waf DetectionOnly)
det_codes=""; for p in "${PAY[@]}"; do det_codes+="$(hit "$p") "; done
sleep 2
ev=$(agent waf.events "{\"cursor\":\"$CUR\",\"limit\":100}")
n_block=$(jget "$ev" "sum(1 for e in d['body']['data']['events'] if e['website_uuid']=='$SITE' and e['action']=='blocked')")
n_det=$(jget "$ev" "sum(1 for e in d['body']['data']['events'] if e['website_uuid']=='$SITE' and e['action']=='detected')")
if ok "$vh" && ok "$w_on" && [ "$(data "$w_on" '["available"]')" = True ] && [ "$on_codes" = "403 403 403 " ] && [ "$clean_on" = 200 ] \
  && ok "$w_det" && [ "$det_codes" = "200 200 200 " ] && [ "${n_block:-0}" -ge 3 ] && [ "${n_det:-0}" -ge 3 ]; then
  row S3 "WAF ModSecurity + CRS" "On: SQLi/XSS/traversal 403, trang thường 200; DetectionOnly: 200 + ghi nhận" PASS "On: $on_codes/ thường $clean_on; Detect: $det_codes; sự kiện blocked=$n_block detected=$n_det (rule $(jget "$ev" "d['body']['data']['events'][0]['rule_id']"))"
else
  row S3 "WAF" "chặn khi On" FAIL "vhost=$(code "$vh") on=$(code "$w_on") avail=$(data "$w_on" '["available"]') on_codes=$on_codes clean=$clean_on det=$(code "$w_det") det_codes=$det_codes events=$(code "$ev") b=$n_block d=$n_det"
fi

# ---------------------------------------------------------------- S4 EICAR + tải khi quét
mkdir -p "/home/$A/sites/$DOM/public/up"
printf '%s' "$EICAR" >"/home/$A/sites/$DOM/public/up/eicar.txt"
for i in $(seq 1 3000); do head -c 2048 /dev/urandom >"/home/$A/sites/$DOM/public/up/f$i.bin"; done
chown -R "$A:$A" "/home/$A/sites/$DOM/public/up"
SC=$(uuid)
load0=$(cut -d' ' -f1 /proc/loadavg)
agent malware.scan "{\"account\":$AJ,\"scan_uuid\":\"$SC\",\"target\":\"sites/$DOM\",\"engines\":[\"clamav\",\"yara\"],\"max_file_mb\":25}" >/tmp/itso-scan.json &
SPID=$!
lat=""; codes=""
while kill -0 "$SPID" 2>/dev/null; do
  r=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' -H "Host: $DOM" http://127.0.0.1/)
  codes+="${r%% *} "; lat+="${r##* } "
  sleep 1
done
wait "$SPID"
scan=$(cat /tmp/itso-scan.json)
load1=$(cut -d' ' -f1 /proc/loadavg)
maxlat=$(printf '%s\n' $lat | sort -n | tail -n1)
bad_codes=$(printf '%s\n' $codes | grep -vc '^200$')
fsha=$(jget "$scan" "[f['sha256'] for f in d['body']['data']['findings'] if f['path'].endswith('eicar.txt')][0]")
QI=$(uuid)
q=$(agent malware.quarantine "{\"account\":$AJ,\"item_uuid\":\"$QI\",\"path\":\"sites/$DOM/public/up/eicar.txt\",\"expected_sha256\":\"$fsha\"}")
gone=$([ -e "/home/$A/sites/$DOM/public/up/eicar.txt" ] && echo còn || echo đã chuyển)
rs=$(agent malware.restore "{\"account\":$AJ,\"item_uuid\":\"$QI\",\"original_path\":\"sites/$DOM/public/up/eicar.txt\",\"sha256\":\"$fsha\",\"overwrite\":false}")
back_owner=$(stat -c %u "/home/$A/sites/$DOM/public/up/eicar.txt" 2>/dev/null)
if ok "$scan" && [ -n "$fsha" ] && [ "$bad_codes" = 0 ] && ok "$q" && [ "$gone" = "đã chuyển" ] && ok "$rs" && [ "$back_owner" = "$AU" ]; then
  row S4 "EICAR: quét → cách ly → khôi phục; tải khi quét" "tìm thấy EICAR, site luôn 200, khôi phục đúng chủ" PASS "files=$(data "$scan" '["files_scanned"]') findings=$(jget "$scan" "len(d['body']['data']['findings'])"); load $load0→$load1; latency tối đa ${maxlat}s; khôi phục uid $back_owner"
else
  row S4 "EICAR + tải" "tìm thấy + site 200" FAIL "scan=$(code "$scan") sha=${fsha:0:12} non200=$bad_codes q=$(code "$q") $gone restore=$(code "$rs") owner=$back_owner"
fi
rm -f /tmp/itso-scan.json

# ---------------------------------------------------------------- S5 FIM
echo '#!/bin/sh' >/usr/local/bin/itso-vm-fim
echo '# vm' >>/etc/ssh/sshd_config.d/99-itso-vm.conf
touch /usr/local/bin/itso-vm-suid && chmod 0755 /usr/local/bin/itso-vm-suid
bl=$(agent fim.baseline '{}') # baseline gồm 3 file thử ở trạng thái ban đầu
chmod 4755 /usr/local/bin/itso-vm-suid # setuid → metadata
rm -f /usr/local/bin/itso-vm-fim
echo '#!/bin/sh' >/usr/local/bin/itso-vm-fim2
echo '# vm sửa' >>/etc/ssh/sshd_config.d/99-itso-vm.conf
fc=$(agent fim.check '{}')
ch() { jget "$fc" "next((c['change'] for c in d['body']['data']['changes'] if c['path']=='$1'), '-')"; }
c_add=$(ch /usr/local/bin/itso-vm-fim2); c_mod=$(ch /etc/ssh/sshd_config.d/99-itso-vm.conf); c_rm=$(ch /usr/local/bin/itso-vm-fim)
c_meta=$(ch /usr/local/bin/itso-vm-suid)
if ok "$bl" && ok "$fc" && [ "$c_add" = added ] && [ "$c_mod" = modified ] && [ "$c_rm" = removed ] && [ "$c_meta" = metadata ]; then
  row S5 "FIM file hệ thống" "added/modified/removed/metadata (setuid) đúng đường dẫn" PASS "baseline $(data "$bl" '["files"]') file; checked=$(data "$fc" '["checked"]'); thay đổi: $(jget "$fc" "len(d['body']['data']['changes'])")"
else
  row S5 "FIM" "phát hiện thay đổi" FAIL "baseline=$(code "$bl") check=$(code "$fc") add=$c_add mod=$c_mod rm=$c_rm meta=$c_meta"
fi
rm -f /usr/local/bin/itso-vm-fim2 /usr/local/bin/itso-vm-suid /etc/ssh/sshd_config.d/99-itso-vm.conf
agent fim.baseline '{}' >/dev/null

# ---------------------------------------------------------------- S6 điểm mặc định sau cài
ART="frankenphp php-cli /opt/itso/current/api/artisan"
au=$(setpriv --reuid=itso --regid="$(id -g itso)" --init-groups $ART itso:security-audit --no-interaction 2>&1 | tail -n2)
score=$(sudo -u postgres psql -d itso -tAc "select min(score) from security_settings" 2>/dev/null | tr -d ' ')
if [ -n "$score" ] && [ "$score" -ge 80 ] 2>/dev/null; then
  row S6 "Điểm bảo mật mặc định sau cài" "≥ 80" PASS "điểm $score; $au"
elif [ -z "$score" ]; then
  row S6 "Điểm bảo mật mặc định" "≥ 80" SKIP "chưa có security_settings (wizard chưa xong?): $au"
else
  row S6 "Điểm bảo mật mặc định" "≥ 80" FAIL "điểm $score; $au"
fi

# ---------------------------------------------------------------- S7 terminal root theo policy
R1=$(uuid); R2=$(uuid)
pol0=$(agent pty.policy '{}')
off=$(agent pty.open.root "{\"session_uuid\":\"$R1\",\"cols\":100,\"rows\":30,\"idle_timeout_sec\":900}")
itso policy set terminal.root on >/dev/null 2>&1
systemctl restart itso-agent && wait_agent
on=$(agent pty.open.root "{\"session_uuid\":\"$R2\",\"cols\":100,\"rows\":30,\"idle_timeout_sec\":900}")
out=""
if ok "$on"; then
  out=$(setpriv --reuid=itso-gw --regid="$(id -g itso-gw)" --init-groups python3 "$VM_DIR/lib/term_client.py" "$(data "$on" '["ticket"]')" \
    'id -u' 'echo ITSO-ROOT-MARK' 2>&1)
fi
rec="/var/lib/itso/recordings/$R2.cast"
rmode=$(stat -c '%a %U' "$rec" 2>/dev/null)
rmark=$(grep -c ITSO-ROOT-MARK "$rec" 2>/dev/null)
rr=$(agent pty.recording.read "{\"session_uuid\":\"$R2\",\"offset\":0,\"max_bytes\":65536}")
itso policy set terminal.root off >/dev/null 2>&1
systemctl restart itso-agent && wait_agent
off2=$(agent pty.open.root "{\"session_uuid\":\"$(uuid)\",\"cols\":100,\"rows\":30,\"idle_timeout_sec\":900}")
if [ "$(data "$pol0" '["root_enabled"]')" = False ] && [ "$(code "$off")" = op_disabled ] && ok "$on" && [[ "$out" == *$'\n0'* || "$out" == "0"* ]] \
  && [ "$rmode" = "600 root" ] && [ "${rmark:-0}" -ge 1 ] && ok "$rr" && [ "$(code "$off2")" = op_disabled ]; then
  row S7 "Terminal root theo policy" "tắt → op_disabled; bật → uid 0, bản ghi 0600 root; tắt lại → op_disabled" PASS "bản ghi $rmode, $(stat -c %s "$rec") byte, đọc lại $(jget "$rr" "len(d['body']['data']['events'])") sự kiện"
else
  row S7 "Terminal root theo policy" "op_disabled khi tắt" FAIL "policy=$(data "$pol0" '["root_enabled"]') off=$(code "$off") on=$(code "$on") out=$(echo "$out" | tr '\n' ' ' | cut -c1-80) rec=$rmode mark=$rmark read=$(code "$rr") off2=$(code "$off2")"
fi

# ---------------------------------------------------------------- dọn dẹp
agent waf.apply "{\"website_uuid\":\"$SITE\",\"account\":$AJ,\"mode\":\"Off\",\"paranoia_level\":1,\"rule_exclusions\":[]}" >/dev/null
agent nginx.vhost.remove "{\"account\":$AJ,\"website_uuid\":\"$SITE\"}" >/dev/null
rm -rf "/home/$A/sites/$DOM" # account thử giữ lại: VM dùng một lần (account.remove cần quy trình purge 2 bước)
C1=$(uuid)
res=$(fw_apply "$C1" "[$WEB]" 60)
ok "$res" && agent firewall.confirm "{\"apply_id\":\"$C1\",\"token\":\"$(data "$res" '["token"]')\"}" >/dev/null
[ "$FAIL" -eq 0 ]
