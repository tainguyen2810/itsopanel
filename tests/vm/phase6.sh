#!/usr/bin/env bash
# Bộ test VM Phase 6 (Database / File Manager / SFTP-FTPS / Cron / Terminal) — chạy bằng root trong VM Ubuntu 24.04
# ĐÃ CÀI ITSO (sau run-all.sh --no-uninstall), dùng một lần. KHÔNG chạy trên máy thật.
#
#   sudo bash tests/vm/phase6.sh [--report /root/itso-vm-phase6.md] [--upload-mb 1024]
#
# Gọi agent thật qua socket (ký HMAC, lib/agent_call.py) như Laravel làm:
#   S0 cài mariadb + pure-ftpd qua recipe; 2 account (itsoe, itsof)
#   S1 tấn công File Manager trên kernel thật dưới uid account: ../, đường dẫn tuyệt đối, symlink ra /etc và sang
#      account khác, ghi qua thư mục symlink, zip slip + symlink trong archive, hardlink tới /etc/shadow
#   S2 SFTP chroot: chỉ thấy home, không cd ra ngoài, không có shell
#   S3 FTPS: FTP thuần bị từ chối, FTPS đăng nhập được, file tạo ra thuộc uid account
#   S4 cron: run_once chạy đúng uid và trong slice itso-acct-<uid>; timer cron.apply có Slice= và User= đúng
#   S5 upload 1 GB: staging ghi làm 2 lần (giả lập ngắt giữa chừng rồi gửi tiếp) → fs.upload.commit, sha256 khớp
#   S6 database: tạo, import, export (.sql.gz) dưới uid account; import của A không đụng được DB của B
#   S7 terminal: pty.open → socket stream (peercred itso-gw) → shell trong jail đúng uid, không đọc /etc/shadow,
#      không thấy home account khác; caller không phải itso-gw bị từ chối
# Dọn dẹp ở cuối: gỡ cron, FTP, DB, account thử.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

REPORT="${REPORT:-/root/itso-vm-phase6.md}"
UPLOAD_MB=1024
while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT="$2"; shift 2 ;;
    --upload-mb) UPLOAD_MB="$2"; shift 2 ;;
    *) echo "tham số lạ: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "cần root (VM test)" >&2; exit 2; }
[ -S /run/itso/agent.sock ] || { echo "chưa có itso-agent (chạy run-all.sh --no-uninstall trước)" >&2; exit 2; }
trap write_report EXIT

LIMITS='{"disk_mb":3000,"inode_limit":50000,"cpu_percent":100,"ram_mb":512,"tasks_max":128,"io_weight":100,"io_read_bps":null,"io_write_bps":null}'
ok() { [ "$(jget "$1" 'd["body"]["ok"]')" = True ]; }
err() { jget "$1" 'd["body"]["error"]["code"] + ": " + d["body"]["error"]["message"][:160]'; }
code() { jget "$1" 'd["body"].get("error",{}).get("code","ok")'; }
data() { jget "$1" "d['body']['data']$2"; }
acct() { echo "{\"username\":\"$1\",\"uid\":$2}"; }
b64() { printf '%s' "$1" | base64 -w0; }
A=itsoe; AU=20201; B=itsof; BU=20202
AJ=$(acct $A $AU); BJ=$(acct $B $BU)
PW_A="VmPhase6-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"

# ---------------------------------------------------------------- S0 phần mềm + account
s0=""
for r in mariadb pure-ftpd; do
  res=$(agent software.install "{\"recipe\":\"$r\"}")
  ok "$res" || s0+="$r: $(err "$res"); "
done
for u in "$A:$AU" "$B:$BU"; do
  res=$(agent account.ensure "{\"account\":$(acct "${u%%:*}" "${u##*:}"),\"home_path\":\"/home/${u%%:*}\",\"shell\":\"/usr/sbin/nologin\",\"limits\":$LIMITS}")
  ok "$res" || s0+="account ${u%%:*}: $(err "$res"); "
done
if [ -z "$s0" ]; then
  row S0 "Cài mariadb + pure-ftpd, tạo 2 account" "ok" PASS "$(mariadb --version 2>&1 | cut -c1-60); $(pure-ftpd --help 2>&1 | head -n1 | cut -c1-40)"
else
  row S0 "Cài phần mềm / account" "ok" FAIL "$s0"
fi

# ---------------------------------------------------------------- S1 tấn công File Manager (uid account, kernel thật)
echo "bí mật của B" >"/home/$B/secret.txt"
chown "$B:$B" "/home/$B/secret.txt"
chmod 0600 "/home/$B/secret.txt"
as_acct "$A" "itso-acct-$AU.slice" ln -sfn /etc/shadow "/home/$A/l-shadow"
as_acct "$A" "itso-acct-$AU.slice" ln -sfn "/home/$B" "/home/$A/l-peer"
as_acct "$A" "itso-acct-$AU.slice" ln -sfn /etc "/home/$A/l-etc"
hl=$(as_acct "$A" "itso-acct-$AU.slice" ln /etc/shadow "/home/$A/h-shadow" 2>&1 && echo LINKED || echo BLOCKED)
attack() { # attack <mã> <op> <params> → in "mã=code" ; ok = lỗ hổng
  local res
  res=$(agent "$2" "$3")
  if ok "$res"; then echo "$1=OK!"; else echo "$1=$(code "$res")"; fi
}
r=(
  "$(attack dotdot fs.read "{\"account\":$AJ,\"path\":\"../$B/secret.txt\",\"max_bytes\":100}")"
  "$(attack abs fs.read "{\"account\":$AJ,\"path\":\"/etc/shadow\",\"max_bytes\":100}")"
  "$(attack sym-shadow fs.read "{\"account\":$AJ,\"path\":\"l-shadow\",\"max_bytes\":100}")"
  "$(attack sym-peer fs.read "{\"account\":$AJ,\"path\":\"l-peer/secret.txt\",\"max_bytes\":100}")"
  "$(attack sym-list fs.list "{\"account\":$AJ,\"path\":\"l-peer\"}")"
  "$(attack sym-write fs.write "{\"account\":$AJ,\"path\":\"l-etc/itso-pwn\",\"content_b64\":\"$(b64 pwn)\"}")"
  "$(attack sym-chmod fs.chmod "{\"account\":$AJ,\"paths\":[\"l-shadow\"],\"mode\":\"0777\",\"recursive\":false}")"
)
# zip slip: entry ../../../tmp/itso-zipslip + symlink trỏ /etc/shadow trong archive
python3 - "/home/$A/evil.zip" <<'PY'
import sys, zipfile, stat
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("../../../tmp/itso-zipslip", "pwn")
    z.writestr("ok.txt", "hợp lệ")
    zi = zipfile.ZipInfo("link-shadow")
    zi.external_attr = (stat.S_IFLNK | 0o777) << 16
    z.writestr(zi, "/etc/shadow")
PY
chown "$A:$A" "/home/$A/evil.zip"
res=$(agent fs.extract "{\"account\":$AJ,\"archive\":\"evil.zip\",\"target\":\"out\",\"max_total_bytes\":1048576,\"max_entries\":100}")
zs="extract=$(code "$res")"
[ -e /tmp/itso-zipslip ] && zs+=" SLIP!"
[ -L "/home/$A/out/link-shadow" ] && zs+=" SYMLINK!"
leak=""
for x in "${r[@]}"; do [[ "$x" == *OK!* ]] && leak+="$x "; done
[ -e /etc/itso-pwn ] && leak+="/etc/itso-pwn tồn tại "
[ "$(stat -c %a /etc/shadow)" = 640 ] || [ "$(stat -c %a /etc/shadow)" = 600 ] || leak+="mode shadow đổi "
[ "$hl" = LINKED ] && leak+="hardlink shadow "
[[ "$zs" == *!* ]] && leak+="$zs "
if [ -z "$leak" ]; then
  row S1 "Tấn công File Manager dưới uid account" "mọi đường bị chặn" PASS "${r[*]}; $zs; hardlink: $hl"
else
  row S1 "Tấn công File Manager dưới uid account" "mọi đường bị chặn" FAIL "lọt: $leak | ${r[*]}"
fi

# ---------------------------------------------------------------- S2 SFTP chroot
KEY=$(mktemp -d)/id
ssh-keygen -q -t ed25519 -N '' -f "$KEY"
res=$(agent sftp.user.ensure "{\"account\":$AJ,\"ssh_access\":false,\"password\":\"$PW_A\"}")
res2=$(agent ssh.keys.apply "{\"account\":$AJ,\"keys\":[\"$(cat "$KEY.pub")\"]}")
SSHO=(-i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=5)
if ok "$res" && ok "$res2"; then
  lsroot=$(printf 'ls -1 /\n' | sftp "${SSHO[@]}" -b - "$A@127.0.0.1" 2>&1 | grep -v '^sftp>' | tr '\n' ' ')
  cdout=$(printf 'cd /etc\n' | sftp "${SSHO[@]}" -b - "$A@127.0.0.1" 2>&1 | tr '\n' ' ')
  cdup=$(printf 'cd ../..\npwd\nls -1\n' | sftp "${SSHO[@]}" -b - "$A@127.0.0.1" 2>&1 | grep -v '^sftp>' | tr '\n' ' ')
  shell=$(ssh "${SSHO[@]}" "$A@127.0.0.1" id 2>&1 | tr '\n' ' ')
  if [[ "$cdout" == *"No such file"* || "$cdout" == *"not found"* ]] && [[ "$lsroot" != *etc* ]] && [[ "$cdup" != *"$B"* ]] && [[ "$shell" != *"uid=$AU"* ]]; then
    row S2 "SFTP chroot" "chỉ thấy home, không cd ra ngoài, không có shell" PASS "ls /: ${lsroot:0:80}; cd /etc: ${cdout:0:60}; ssh id: ${shell:0:60}"
  else
    row S2 "SFTP chroot" "không thoát chroot" FAIL "ls /: $lsroot | cd /etc: $cdout | cd ../..: $cdup | ssh id: $shell"
  fi
else
  row S2 "SFTP chroot" "tạo user SFTP + key" FAIL "$(err "$res") $(err "$res2")"
fi

# ---------------------------------------------------------------- S3 FTPS bắt buộc TLS
FU="${A}_ftp"; FPW="VmFtp6-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
res=$(agent ftp.user.ensure "{\"account\":$AJ,\"username\":\"$FU\",\"root_path\":\".\",\"enabled\":true,\"password\":\"$FPW\"}")
if ok "$res"; then
  plain=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "ftp://127.0.0.1/" --user "$FU:$FPW" 2>&1)
  echo "ftps $(date +%s)" >/tmp/itso-ftps.txt
  tls=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --ssl-reqd -k -T /tmp/itso-ftps.txt "ftp://127.0.0.1/itso-ftps.txt" --user "$FU:$FPW" 2>&1)
  owner=$(stat -c %u "/home/$A/itso-ftps.txt" 2>/dev/null)
  if [ "$plain" != 226 ] && [ "$plain" != 250 ] && { [ "$tls" = 226 ] || [ "$tls" = 250 ]; } && [ "$owner" = "$AU" ]; then
    row S3 "FTPS bắt buộc TLS" "FTP thuần bị từ chối; FTPS ghi file thuộc uid account" PASS "FTP thuần: $plain; FTPS upload: $tls; owner uid $owner"
  else
    row S3 "FTPS bắt buộc TLS" "FTP thuần bị từ chối" FAIL "FTP thuần: $plain; FTPS: $tls; owner: ${owner:-không có file}"
  fi
else
  row S3 "FTPS" "tạo user FTP" FAIL "$(err "$res")"
fi

# ---------------------------------------------------------------- S4 cron đúng uid + slice
CU=01938a97-0001-7000-8000-000000000001
res=$(agent cron.run_once "{\"account\":$AJ,\"uuid\":\"$CU\",\"command\":\"id -u; cat /proc/self/cgroup\",\"working_dir\":\".\",\"timeout_sec\":60}")
out=$(data "$res" '["output_tail"]')
res2=$(agent cron.apply "{\"account\":$AJ,\"entries\":[{\"uuid\":\"$CU\",\"schedule\":\"*/5 * * * *\",\"command\":\"true\",\"working_dir\":\".\",\"enabled\":true,\"timeout_sec\":60}]}")
slice=$(systemctl show -p Slice --value "itso-cron-$CU.service" 2>/dev/null)
user=$(systemctl show -p User --value "itso-cron-$CU.service" 2>/dev/null)
timer=$(systemctl is-active "itso-cron-$CU.timer" 2>/dev/null)
if ok "$res" && [[ "$out" == "$AU"* ]] && [[ "$out" == *"itso-acct-$AU.slice"* ]] && ok "$res2" && [ "$slice" = "itso-acct-$AU.slice" ] && { [ "$user" = "$A" ] || [ "$user" = "$AU" ]; } && [ "$timer" = active ]; then
  row S4 "Cron chạy dưới uid account, trong slice" "uid $AU, slice itso-acct-$AU.slice" PASS "run_once: $(echo "$out" | tr '\n' ' ' | cut -c1-120); timer $timer, Slice=$slice, User=$user"
else
  row S4 "Cron uid + slice" "uid $AU, slice itso-acct-$AU.slice" FAIL "run_once: $(ok "$res" && echo "$out" | tr '\n' ' ' || err "$res"); apply: $(ok "$res2" && echo ok || err "$res2"); Slice=$slice User=$user timer=$timer"
fi
agent cron.apply "{\"account\":$AJ,\"entries\":[]}" >/dev/null

# ---------------------------------------------------------------- S5 upload 1 GB resumable
UU=01938a97-0002-7000-8000-000000000002
STG=/var/lib/itso/uploads/$UU.part
mkdir -p /var/lib/itso/uploads
SRC=$(mktemp /var/tmp/itso-up.XXXX)
t0=$(date +%s)
head -c "$((UPLOAD_MB * 1048576))" /dev/urandom >"$SRC"
want=$(sha256sum "$SRC" | cut -c1-64)
HALF=$((UPLOAD_MB / 2))
# Lần 1: nửa đầu (giả lập mất kết nối), lần 2: gửi tiếp từ offset đã nhận như PATCH Content-Range.
dd if="$SRC" of="$STG" bs=1M count="$HALF" status=none
got=$(stat -c %s "$STG")
dd if="$SRC" of="$STG" bs=1M skip="$((got / 1048576))" seek="$((got / 1048576))" conv=notrunc status=none
id itso >/dev/null 2>&1 && chown itso:itso "$STG"
chmod 0640 "$STG"
res=$(agent fs.upload.commit "{\"account\":$AJ,\"upload_uuid\":\"$UU\",\"target\":\"big.bin\",\"size\":$((UPLOAD_MB * 1048576)),\"overwrite\":true}")
dt=$(($(date +%s) - t0))
gotsum=$(sha256sum "/home/$A/big.bin" 2>/dev/null | cut -c1-64)
own=$(stat -c %u "/home/$A/big.bin" 2>/dev/null)
if ok "$res" && [ "$gotsum" = "$want" ] && [ "$own" = "$AU" ] && [ ! -e "$STG" ]; then
  row S5 "Upload ${UPLOAD_MB} MB gửi tiếp sau khi ngắt" "commit đủ byte, sha256 khớp, thuộc uid account, staging bị xóa" PASS "nửa đầu ${got} byte rồi gửi tiếp; sha256 ${want:0:16}…; ${dt} giây"
else
  row S5 "Upload ${UPLOAD_MB} MB resumable" "sha256 khớp" FAIL "$(ok "$res" && echo commit ok || err "$res"); sha ${gotsum:0:16} vs ${want:0:16}; owner $own; staging còn: $([ -e "$STG" ] && echo có || echo không)"
fi
rm -f "$SRC" "/home/$A/big.bin"

# ---------------------------------------------------------------- S6 database import/export + cô lập
s6=""
for u in "$AJ:${A}_app" "$BJ:${B}_app"; do
  aj="${u%:*}"; db="${u##*:}"
  for op in "db.mysql.owner_ensure {\"account\":$aj}" "db.mysql.create {\"account\":$aj,\"name\":\"$db\",\"charset\":\"utf8mb4\"}"; do
    res=$(agent ${op%% *} "${op#* }")
    ok "$res" || s6+="${op%% *} $db: $(err "$res"); "
  done
done
mariadb -e "CREATE TABLE ${B}_app.keep (v int); INSERT INTO ${B}_app.keep VALUES (42);"
printf 'CREATE TABLE t (id int primary key, name varchar(20));\nINSERT INTO t VALUES (1,"xin chào");\n' >"/home/$A/in.sql"
printf 'DROP TABLE IF EXISTS %s_app.keep;\nCREATE TABLE %s_app.pwn (x int);\n' "$B" "$B" >"/home/$A/evil.sql"
chown "$A:$A" "/home/$A/in.sql" "/home/$A/evil.sql"
imp=$(agent db.mysql.import "{\"account\":$AJ,\"name\":\"${A}_app\",\"source\":\"in.sql\"}")
dump=$(agent db.mysql.dump "{\"account\":$AJ,\"name\":\"${A}_app\",\"target\":\"backups/a.sql.gz\",\"compress\":true}")
evil=$(agent db.mysql.import "{\"account\":$AJ,\"name\":\"${A}_app\",\"source\":\"evil.sql\"}")
row1=$(mariadb -N -e "SELECT name FROM ${A}_app.t WHERE id=1" 2>&1)
keep=$(mariadb -N -e "SELECT v FROM ${B}_app.keep" 2>&1)
pwn=$(mariadb -N -e "SHOW TABLES FROM ${B}_app LIKE 'pwn'" 2>&1)
dz=$(zcat "/home/$A/backups/a.sql.gz" 2>/dev/null | grep -c 'xin chào')
downer=$(stat -c %u "/home/$A/backups/a.sql.gz" 2>/dev/null)
if [ -z "$s6" ] && ok "$imp" && ok "$dump" && ! ok "$evil" && [ "$row1" = "xin chào" ] && [ "$keep" = 42 ] && [ -z "$pwn" ] && [ "$dz" -ge 1 ] && [ "$downer" = "$AU" ]; then
  row S6 "Database import/export, cô lập account" "import/export dưới uid A; SQL của A không đụng DB của B" PASS "import $(data "$imp" '["bytes"]') byte; dump $(data "$dump" '["size"]') byte (uid $downer); SQL độc: $(err "$evil" | cut -c1-80); B.keep=$keep"
else
  row S6 "Database import/export, cô lập" "SQL của A không đụng DB của B" FAIL "${s6}imp=$(code "$imp") dump=$(code "$dump") evil=$(code "$evil") row='$row1' keep='$keep' pwn='$pwn' dump có dữ liệu=$dz owner=$downer"
fi

# ---------------------------------------------------------------- S7 terminal trong jail
SU=01938a97-0003-7000-8000-000000000003
agent sftp.user.ensure "{\"account\":$AJ,\"ssh_access\":true,\"password\":null}" >/dev/null # gói có SSH: shell bash
res=$(agent pty.open "{\"account\":$AJ,\"session_uuid\":\"$SU\",\"cols\":120,\"rows\":40,\"idle_timeout_sec\":900}")
if ok "$res"; then
  tk=$(data "$res" '["ticket"]')
  out=$(setpriv --reuid=itso-gw --regid="$(id -g itso-gw)" --init-groups python3 "$VM_DIR/lib/term_client.py" "$tk" \
    'id -u' 'cat /etc/shadow; echo RC=$?' "ls /home/$B; echo RC=\$?" 'cat /proc/self/cgroup' 2>&1)
  res2=$(agent pty.open "{\"account\":$AJ,\"session_uuid\":\"01938a97-0004-7000-8000-000000000004\",\"cols\":80,\"rows\":24,\"idle_timeout_sec\":900}")
  rogue=$(setpriv --reuid=nobody --regid=nogroup --clear-groups python3 "$VM_DIR/lib/term_client.py" "$(data "$res2" '["ticket"]')" 'id' 2>&1 | tail -n1)
  if [[ "$out" == *"$AU"* ]] && [[ "$out" == *"RC=1"* ]] && [[ "$out" != *"bí mật"* ]] && [[ "$out" == *"itso-term-$SU"* || "$out" == *"itso-acct-$AU"* ]] && [[ "$out" == *"#EXIT exited"* ]] && [[ "$rogue" != *"uid="* ]]; then
    row S7 "Terminal trong jail" "uid account, không đọc shadow/home khác, chỉ itso-gw nối được" PASS "$(echo "$out" | tr '\n' ' ' | cut -c1-160); caller nobody: ${rogue:0:60}"
  else
    row S7 "Terminal trong jail" "đúng uid, bị giới hạn" FAIL "$(echo "$out" | tr '\n' ' ' | cut -c1-220) | nobody: $rogue"
  fi
else
  row S7 "Terminal" "pty.open" FAIL "$(err "$res")"
fi

# ---------------------------------------------------------------- dọn dẹp
agent ftp.user.remove "{\"account\":$AJ,\"username\":\"$FU\"}" >/dev/null
agent ssh.keys.apply "{\"account\":$AJ,\"keys\":[]}" >/dev/null
for u in "$AJ:${A}_app" "$BJ:${B}_app"; do agent db.mysql.drop "{\"account\":${u%:*},\"name\":\"${u##*:}\",\"confirm_name\":\"${u##*:}\"}" >/dev/null; done
rm -f /tmp/itso-ftps.txt /tmp/itso-zipslip
[ "$FAIL" -eq 0 ]
