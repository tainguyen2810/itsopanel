#!/usr/bin/env bash
# Bộ test VM Phase 8 (Backup Center) — chạy bằng root trong VM Ubuntu 24.04 ĐÃ CÀI ITSO
# (sau run-all.sh --no-uninstall), dùng một lần. KHÔNG chạy trên máy thật: script cài rest-server, đổi nftables,
# xóa/ghi đè dữ liệu account thử.
#
#   sudo bash tests/vm/phase8.sh [--report /root/itso-vm-phase8.md]
#   sudo bash tests/vm/phase8.sh --dr-source              # VM1: tạo bản backup panel + gói khôi phục (B6)
#   sudo bash tests/vm/phase8.sh --dr-target <kit.tar>    # VM2 mới cài: khôi phục panel theo runbook (B6)
#
# Gọi agent thật qua socket (ký HMAC, lib/agent_call.py) như Laravel làm (bí mật đã giải ở phía panel):
#   B0 cài restic, mariadb, nginx (recipe) + rest-server, age; account + website tĩnh thử
#   B1 backup files → xóa site → restore website (overwrite) → sha256 từng file khớp + HTTP 200
#   B2 DB MariaDB: backup → xóa dòng → restore → số dòng + CHECKSUM TABLE khớp
#   B3 rest-server --append-only: backup được, backup.forget bằng credential panel THẤT BẠI, snapshot còn nguyên
#   B4 mất mạng giữa chừng (nftables chặn cổng rest-server) → op lỗi, không có snapshot mới; mở lại → lần sau xong
#   B5 tải khi backup: restic chạy trong itso-maint.slice (CPUQuota 50 %, Nice 10); site vẫn 200 trong lúc backup
#   B6 DR 2 VM theo docs/runbooks/disaster-recovery.md (chỉ chạy với --dr-source / --dr-target; không thì SKIP)
# Dọn dẹp ở cuối: gỡ vhost, rule nftables thử, dừng rest-server. Account thử giữ lại (VM dùng một lần).
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

REPORT="${REPORT:-/root/itso-vm-phase8.md}"
MODE=main
KIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT="$2"; shift 2 ;;
    --dr-source) MODE=dr-source; shift ;;
    --dr-target) MODE=dr-target; KIT="$2"; shift 2 ;;
    *) echo "tham số lạ: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "cần root (VM test)" >&2; exit 2; }
[ -S /run/itso/agent.sock ] || { echo "chưa có itso-agent (chạy run-all.sh --no-uninstall trước)" >&2; exit 2; }
trap 'cleanup; write_report' EXIT

ok() { [ "$(jget "$1" 'd["body"]["ok"]')" = True ]; }
err() { jget "$1" 'd["body"]["error"]["code"] + ": " + d["body"]["error"]["message"][:160]'; }
code() { jget "$1" 'd["body"].get("error",{}).get("code","ok")'; }
data() { jget "$1" "d['body']['data']$2"; }
uuid() { cat /proc/sys/kernel/random/uuid; }
pw() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32; }
acct() { echo "{\"username\":\"$1\",\"uid\":$2}"; }

LIMITS='{"disk_mb":3000,"inode_limit":50000,"cpu_percent":100,"ram_mb":512,"tasks_max":128,"io_weight":100,"io_read_bps":null,"io_write_bps":null}'
VERSION="0.1.0-alpha"
SRV=$(cat /etc/itso/server-uuid 2>/dev/null || uuid)
A=itsoh; AU=20401; AJ=$(acct $A $AU); AUUID=$(uuid)
SITE=$(uuid); DOM=bk.vm8.itso.test
SITE_ROOT="/home/$A/sites/$DOM"
DB="${A}_bk"
REST_PORT=18000
REST_DIR=/srv/itso-rest
REST_USER=itso-panel
REST_PID=""
NFT_RULE=no

repo_json() { # repo_json <repo_uuid> <path> <destination JSON> <password>
  echo "{\"repo_uuid\":\"$1\",\"path\":\"$2\",\"destination\":$3,\"password\":\"$4\"}"
}
meta() { echo "{\"panel_version\":\"$VERSION\",\"server_uuid\":\"$SRV\",\"account_uuid\":$1,\"package\":null}"; }
run_files() { # run_files <repo JSON> [cờ agent]
  local r="$1"; shift
  agent backup.run "{\"repo\":$r,\"kind\":\"files\",\"account\":$AJ,\"website_uuid\":\"$SITE\",\"site_dir\":\"$DOM\",\"databases\":[],\"excludes\":[],\"tags\":[\"itso\",\"type:files\",\"account:$AUUID\",\"website:$SITE\",\"manual\"],\"age_recipient\":null,\"meta\":$(meta "\"$AUUID\"")}" "$@"
}
count_snaps() { # count_snaps <repo JSON> <tag>
  local s
  s=$(agent backup.snapshots "{\"repo\":$1,\"tags\":[\"$2\"],\"limit\":1000}")
  ok "$s" && jget "$s" "len(d['body']['data']['snapshots'])" || echo "?"
}
hit() { curl -s -o /dev/null -w '%{http_code}' -H "Host: $DOM" "http://127.0.0.1$1"; }
sums() { (cd "$SITE_ROOT" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64); }

cleanup() {
  [ "$NFT_RULE" = yes ] && nft delete table inet itso_vm8 2>/dev/null
  [ -n "$REST_PID" ] && kill "$REST_PID" 2>/dev/null
  if [ "$MODE" = main ]; then
    agent nginx.vhost.remove "{\"account\":$AJ,\"website_uuid\":\"$SITE\"}" >/dev/null 2>&1
  fi
}

# ================================================================ B6: chế độ DR (2 VM)
if [ "$MODE" = dr-source ]; then
  apt-get install -y -q age >/dev/null 2>&1
  KD=/root/itso-dr-kit; rm -rf "$KD"; install -d -m 0700 "$KD"
  age-keygen -o "$KD/age.key" 2>/dev/null
  RCP=$(age-keygen -y "$KD/age.key")
  DEST="{\"type\":\"local\",\"destination_uuid\":\"$(uuid)\"}"
  RP="itso/$SRV/server"; PW=$(pw); RU=$(uuid)
  R=$(repo_json "$RU" "$RP" "$DEST" "$PW")
  init=$(agent backup.repo.init "{\"repo\":$R}")
  bk=$(agent backup.run "{\"repo\":$R,\"kind\":\"panel\",\"account\":null,\"website_uuid\":null,\"site_dir\":null,\"databases\":[],\"excludes\":[],\"tags\":[\"itso\",\"type:panel\",\"manual\"],\"age_recipient\":\"$RCP\",\"meta\":$(meta null)}" --timeout 1800)
  if ok "$init" && ok "$bk"; then
    sid=$(data "$bk" '["snapshot_id"]')
    printf 'REPO_UUID=%s\nREPO_PATH=%s\nREPO_PASSWORD=%s\nDEST=%s\nSNAPSHOT=%s\n' "$RU" "$RP" "$PW" "$DEST" "$sid" >"$KD/kit.env"
    sudo -u postgres psql -d itso -tAc "select count(*) from hosting_accounts where status in ('active','suspended')" >"$KD/accounts" 2>/dev/null
    tar -C / -cf /root/itso-dr-kit.tar "${KD#/}" "var/backups/itso/repos/$RP" && chmod 0600 /root/itso-dr-kit.tar
    row B6a "DR nguồn: backup panel (age) + gói khôi phục" "snapshot type:panel; gói /root/itso-dr-kit.tar" PASS "snapshot ${sid:0:8}, $(stat -c %s /root/itso-dr-kit.tar) byte; chép sang VM2 rồi chạy --dr-target"
  else
    row B6a "DR nguồn" "backup panel" FAIL "init=$(code "$init") run=$(code "$bk") $(err "$bk")"
  fi
  [ "$FAIL" -eq 0 ]; exit
fi

if [ "$MODE" = dr-target ]; then
  [ -f "$KIT" ] || { echo "không thấy gói $KIT" >&2; exit 2; }
  tar -C / -xf "$KIT"
  # shellcheck disable=SC1091
  . /root/itso-dr-kit/kit.env
  R=$(repo_json "$REPO_UUID" "$REPO_PATH" "$DEST" "$REPO_PASSWORD")
  t0=$(date +%s)
  pr=$(agent panel.restore "{\"repo\":$R,\"snapshot_id\":\"$SNAPSHOT\",\"age_identity\":\"$(grep -o 'AGE-SECRET-KEY-1[0-9A-Z]*' /root/itso-dr-kit/age.key)\",\"apply_delay_sec\":10}" --timeout 1800)
  st=""
  for _ in $(seq 1 120); do
    st=$(python3 -c 'import json;print(json.load(open("/var/lib/itso/restore/last-apply.json")).get("status",""))' 2>/dev/null)
    [ -n "$st" ] && [ "$(stat -c %Y /var/lib/itso/restore/last-apply.json)" -ge "$t0" ] && break
    st=""; sleep 5
  done
  want=$(cat /root/itso-dr-kit/accounts 2>/dev/null | tr -d ' ')
  have=$(sudo -u postgres psql -d itso -tAc "select count(*) from hosting_accounts where status in ('active','suspended')" 2>/dev/null | tr -d ' ')
  ART="frankenphp php-cli /opt/itso/current/api/artisan"
  dry=$(setpriv --reuid=itso --regid="$(id -g itso)" --init-groups $ART itso:dr-restore --dry-run --no-interaction 2>&1 | tail -n3)
  stat_ok=no; itso status >/dev/null 2>&1 && stat_ok=yes
  if ok "$pr" && [ "$st" = ok ] && [ -n "$want" ] && [ "$want" = "$have" ] && [ "$stat_ok" = yes ]; then
    row B6b "DR đích: panel.restore → apply theo runbook" "last-apply ok; số account khớp; itso status PASS" PASS "staged $(data "$pr" '["staged_dir"]'); account $have; $(($(date +%s) - t0)) s; dr-restore: $dry"
  else
    row B6b "DR đích" "khôi phục panel" FAIL "restore=$(code "$pr") apply=$st account $have/$want status=$stat_ok $(ok "$pr" || err "$pr")"
  fi
  [ "$FAIL" -eq 0 ]; exit
fi

# ================================================================ B0 gói + account + website
b0=""
for r in restic mariadb nginx; do
  res=$(agent software.install "{\"recipe\":\"$r\"}")
  ok "$res" || b0+="$r: $(err "$res"); "
done
apt-get install -y -q age apache2-utils >/dev/null 2>&1 || b0+="apt age/apache2-utils; "
REST_BIN=$(command -v rest-server || true)
if [ -z "$REST_BIN" ]; then
  apt-get install -y -q rest-server >/dev/null 2>&1 || apt-get install -y -q restic-rest-server >/dev/null 2>&1
  REST_BIN=$(command -v rest-server || true)
fi
res=$(agent account.ensure "{\"account\":$AJ,\"home_path\":\"/home/$A\",\"shell\":\"/usr/sbin/nologin\",\"limits\":$LIMITS}")
ok "$res" || b0+="account: $(err "$res"); "
install -d -o $A -g $A "$SITE_ROOT/public/assets"
echo "<h1>ITSO VM8 $(date -Is)</h1>" >"$SITE_ROOT/public/index.html"
head -c 2000000 /dev/urandom >"$SITE_ROOT/public/assets/blob.bin"
for i in $(seq 1 50); do echo "trang $i" >"$SITE_ROOT/public/assets/p$i.txt"; done
chown -R $A:$A "$SITE_ROOT"
vh=$(agent nginx.vhost.apply "{\"account\":$AJ,\"website_uuid\":\"$SITE\",\"site_dir\":\"$DOM\",\"type\":\"static\",\"server_names\":[\"$DOM\"],\"document_root\":\"public\",\"php_socket\":null,\"tls\":null,\"client_max_body_size\":\"16m\",\"extra_headers\":{},\"suspended\":false,\"redirect_names\":[],\"http2\":true,\"proxy_port\":null,\"redirects\":[]}")
ok "$vh" || b0+="vhost: $(err "$vh"); "
if [ -z "$b0" ] && [ "$(hit /)" = 200 ]; then
  row B0 "Cài restic, mariadb, nginx, age, rest-server; account + website tĩnh" "ok; site 200" PASS "$(restic version 2>&1 | cut -c1-40); rest-server=${REST_BIN:-không có}; $(age --version 2>&1)"
else
  row B0 "Cài gói + website thử" "ok" FAIL "${b0}site=$(hit /)"
fi

LDEST="{\"type\":\"local\",\"destination_uuid\":\"$(uuid)\"}"
LR=$(repo_json "$(uuid)" "itso/$SRV/acct-$AUUID" "$LDEST" "$(pw)")
init=$(agent backup.repo.init "{\"repo\":$LR}")
lmode=$(stat -c '%a %U' /var/backups/itso 2>/dev/null)

# ================================================================ B1 files: backup → xóa site → restore
before=$(sums)
b1=$(run_files "$LR" --timeout 900)
sid1=$(data "$b1" '["snapshot_id"]')
rm -rf "$SITE_ROOT/public"
gone=$(hit /)
rs=$(agent backup.restore "{\"repo\":$LR,\"snapshot_id\":\"$sid1\",\"restore_uuid\":\"$(uuid)\",\"account\":$AJ,\"mode\":\"overwrite\",\"items\":[{\"kind\":\"website\",\"site_dir\":\"$DOM\"}],\"pre_restore_tags\":[\"itso\",\"type:files\",\"account:$AUUID\",\"pre-restore\"]}" --timeout 900)
after=$(sums 2>/dev/null)
owner=$(stat -c %U "$SITE_ROOT/public/index.html" 2>/dev/null)
if ok "$init" && ok "$b1" && ok "$rs" && [ "$before" = "$after" ] && [ "$gone" != 200 ] && [ "$(hit /)" = 200 ] && [ "$owner" = $A ]; then
  row B1 "Backup files → xóa site → restore website" "sha256 toàn cây khớp, HTTP 200, chủ sở hữu account" PASS "snapshot ${sid1:0:8}; sau xóa HTTP $gone; sha ${after:0:12}; /var/backups/itso $lmode; pre-restore $(data "$rs" '["pre_restore_snapshot_id"]' | cut -c1-8)"
else
  row B1 "Backup/restore website" "khớp" FAIL "init=$(code "$init") run=$(code "$b1") restore=$(code "$rs") sha ${before:0:12}/${after:0:12} gone=$gone now=$(hit /) owner=$owner $(ok "$rs" || err "$rs")"
fi

# ================================================================ B2 DB: số dòng + checksum bảng
dbc=$(agent db.mysql.create "{\"account\":$AJ,\"name\":\"$DB\",\"charset\":\"utf8mb4\"}")
mysql "$DB" -e "create table t (id int primary key auto_increment, v varchar(64), n double); insert into t (v,n) select uuid(), rand() from seq_1_to_5000;" 2>/dev/null \
  || mysql "$DB" -e "create table if not exists t (id int primary key auto_increment, v varchar(64), n double); insert into t (v,n) values (uuid(), rand()),(uuid(), rand()),(uuid(), rand());"
cnt0=$(mysql -N "$DB" -e "select count(*) from t" 2>/dev/null)
ck0=$(mysql -N "$DB" -e "checksum table t" 2>/dev/null | awk '{print $2}')
b2=$(agent backup.run "{\"repo\":$LR,\"kind\":\"db\",\"account\":$AJ,\"website_uuid\":null,\"site_dir\":null,\"databases\":[{\"engine\":\"mysql\",\"name\":\"$DB\"}],\"excludes\":[],\"tags\":[\"itso\",\"type:db\",\"account:$AUUID\",\"db:$DB\",\"manual\"],\"age_recipient\":null,\"meta\":$(meta "\"$AUUID\"")}" --timeout 900)
sid2=$(data "$b2" '["snapshot_id"]')
mysql "$DB" -e "delete from t where id % 3 = 0; update t set v='HONG' where id < 100" 2>/dev/null
cntx=$(mysql -N "$DB" -e "select count(*) from t" 2>/dev/null)
r2=$(agent backup.restore "{\"repo\":$LR,\"snapshot_id\":\"$sid2\",\"restore_uuid\":\"$(uuid)\",\"account\":$AJ,\"mode\":\"overwrite\",\"items\":[{\"kind\":\"database\",\"db\":{\"engine\":\"mysql\",\"name\":\"$DB\"},\"target_name\":\"$DB\"}],\"pre_restore_tags\":[\"itso\",\"type:db\",\"account:$AUUID\",\"pre-restore\"]}" --timeout 900)
cnt1=$(mysql -N "$DB" -e "select count(*) from t" 2>/dev/null)
ck1=$(mysql -N "$DB" -e "checksum table t" 2>/dev/null | awk '{print $2}')
if ok "$dbc" && ok "$b2" && ok "$r2" && [ -n "$cnt0" ] && [ "$cnt0" = "$cnt1" ] && [ -n "$ck0" ] && [ "$ck0" = "$ck1" ] && [ "$cntx" != "$cnt0" ]; then
  row B2 "DB MariaDB: backup → hỏng dữ liệu → restore" "số dòng + CHECKSUM TABLE khớp" PASS "snapshot ${sid2:0:8}; $cnt0 dòng (sau xóa $cntx); checksum $ck0"
else
  row B2 "DB restore" "khớp" FAIL "create=$(code "$dbc") run=$(code "$b2") restore=$(code "$r2") dòng $cnt0/$cntx/$cnt1 ck $ck0/$ck1 $(ok "$r2" || err "$r2")"
fi

# ================================================================ B3 rest-server append-only
RR=""
if [ -n "$REST_BIN" ]; then
  install -d -m 0700 "$REST_DIR" "$REST_DIR/tls"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj "/CN=rest.vm8.itso.test" \
    -addext "subjectAltName=DNS:rest.vm8.itso.test" -keyout "$REST_DIR/tls/key.pem" -out "$REST_DIR/tls/cert.pem" 2>/dev/null
  cp "$REST_DIR/tls/cert.pem" /usr/local/share/ca-certificates/itso-vm8-rest.crt && update-ca-certificates >/dev/null 2>&1
  grep -q rest.vm8.itso.test /etc/hosts || echo "127.0.0.1 rest.vm8.itso.test" >>/etc/hosts
  RPW=$(pw)
  htpasswd -B -b -c "$REST_DIR/.htpasswd" "$REST_USER" "$RPW" >/dev/null 2>&1
  "$REST_BIN" --path "$REST_DIR/data" --listen "127.0.0.1:$REST_PORT" --append-only --private-repos \
    --htpasswd-file "$REST_DIR/.htpasswd" --tls --tls-cert "$REST_DIR/tls/cert.pem" --tls-key "$REST_DIR/tls/key.pem" \
    >/var/log/itso-vm8-rest.log 2>&1 &
  REST_PID=$!
  sleep 2
  RDEST="{\"type\":\"rest\",\"destination_uuid\":\"$(uuid)\",\"url\":\"https://rest.vm8.itso.test:$REST_PORT/$REST_USER\",\"user\":\"$REST_USER\",\"password\":\"$RPW\"}"
  dt=$(agent backup.destination.test "{\"destination\":$RDEST}")
  RR=$(repo_json "$(uuid)" "itso/$SRV/acct-$AUUID" "$RDEST" "$(pw)")
  ri=$(agent backup.repo.init "{\"repo\":$RR}")
  b3=$(run_files "$RR" --timeout 900)
  sid3=$(data "$b3" '["snapshot_id"]')
  n3a=$(count_snaps "$RR" type:files)
  fg=$(agent backup.forget "{\"repo\":$RR,\"snapshot_ids\":[\"$sid3\"],\"prune\":true}")
  n3b=$(count_snaps "$RR" type:files)
  if ok "$ri" && ok "$b3" && ! ok "$fg" && [ "$n3a" = "$n3b" ] && [ "$n3a" != "?" ]; then
    row B3 "rest-server --append-only" "backup ok; forget bằng credential panel bị từ chối; snapshot còn" PASS "test.append_only=$(data "$dt" '["append_only"]'); forget → $(code "$fg"); snapshot $n3a → $n3b"
  else
    row B3 "rest-server append-only" "forget thất bại" FAIL "test=$(code "$dt") init=$(code "$ri") run=$(code "$b3") forget=$(code "$fg") snap $n3a/$n3b $(ok "$b3" || err "$b3")"
  fi
else
  row B3 "rest-server append-only" "forget thất bại" SKIP "không cài được rest-server (apt rest-server / restic-rest-server); cài tay bản phát hành rồi chạy lại"
fi

# ================================================================ B4 mất mạng giữa chừng
if [ -n "$RR" ] && ok "$b3"; then
  head -c 400000000 /dev/urandom >"$SITE_ROOT/public/assets/big.bin" && chown $A:$A "$SITE_ROOT/public/assets/big.bin"
  n4a=$(count_snaps "$RR" type:files)
  run_files "$RR" --timeout 900 >/root/itso-vm8-b4.json &
  bp=$!
  sleep 4
  nft add table inet itso_vm8 && NFT_RULE=yes
  nft add chain inet itso_vm8 out '{ type filter hook output priority -10; }'
  nft add rule inet itso_vm8 out tcp dport $REST_PORT drop
  nft add rule inet itso_vm8 out tcp sport $REST_PORT drop
  wait $bp
  cut4=$(cat /root/itso-vm8-b4.json)
  nft delete table inet itso_vm8 && NFT_RULE=no
  n4b=$(count_snaps "$RR" type:files)
  re=$(run_files "$RR" --timeout 1800)
  n4c=$(count_snaps "$RR" type:files)
  if ! ok "$cut4" && [ "$n4a" = "$n4b" ] && ok "$re" && [ "$n4c" = "$((n4a + 1))" ]; then
    row B4 "Mất mạng giữa chừng tới đích" "op lỗi, không ghi nhận snapshot; lần sau chạy tiếp xong" PASS "lần cắt → $(code "$cut4"); snapshot $n4a → $n4b → $n4c; lần sau thêm $(data "$re" '["data_added_bytes"]' 2>/dev/null) byte"
  else
    row B4 "Mất mạng giữa chừng" "không snapshot dở" FAIL "cut=$(code "$cut4") snap $n4a/$n4b/$n4c rerun=$(code "$re") $(ok "$re" || err "$re")"
  fi
else
  row B4 "Mất mạng giữa chừng" "không snapshot dở" SKIP "cần đích rest-server của B3"
fi

# ================================================================ B5 tải khi backup trong itso-maint.slice
[ -f "$SITE_ROOT/public/assets/big.bin" ] || { head -c 400000000 /dev/urandom >"$SITE_ROOT/public/assets/big.bin"; chown $A:$A "$SITE_ROOT/public/assets/big.bin"; }
head -c 300000000 /dev/urandom >"$SITE_ROOT/public/assets/big2.bin" && chown $A:$A "$SITE_ROOT/public/assets/big2.bin"
run_files "$LR" --timeout 1800 >/root/itso-vm8-b5.json &
bp=$!
in_slice=no; quota=""; codes=""; slow=0; worst=0
for _ in $(seq 1 60); do
  if systemctl list-units --no-legend --state=running 'run-*.service' 2>/dev/null | awk '{print $1}' | while read -r u; do
    [ "$(systemctl show -p Slice --value "$u")" = itso-maint.slice ] && systemctl show -p ExecStart --value "$u" | grep -q restic && echo y
  done | grep -q y; then
    in_slice=yes
    u=$(systemctl list-units --no-legend --state=running 'run-*.service' | awk '{print $1}' | while read -r x; do [ "$(systemctl show -p Slice --value "$x")" = itso-maint.slice ] && echo "$x"; done | head -n1)
    quota=$(systemctl show -p CPUQuotaPerSecUSec -p Nice -p IOWeight --value "$u" | tr '\n' ' ')
  fi
  r=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' -H "Host: $DOM" http://127.0.0.1/)
  codes+="${r%% *} "
  t=${r##* }; ms=$(awk -v t="$t" 'BEGIN{printf "%d", t*1000}')
  [ "$ms" -gt "$worst" ] && worst=$ms
  [ "$ms" -gt 2000 ] && slow=$((slow + 1))
  kill -0 $bp 2>/dev/null || break
  sleep 0.5
done
wait $bp
b5=$(cat /root/itso-vm8-b5.json)
non200=$(echo "$codes" | tr ' ' '\n' | grep -v '^$' | grep -vc '^200$')
if ok "$b5" && [ "$in_slice" = yes ] && [ "$non200" -eq 0 ] && [ "$slow" -eq 0 ]; then
  row B5 "Tải khi backup ~700 MB" "restic trong itso-maint.slice; site luôn 200, không chậm > 2 s" PASS "unit: $quota; $(echo "$codes" | wc -w) lượt, chậm nhất ${worst} ms; snapshot $(data "$b5" '["snapshot_id"]' | cut -c1-8)"
else
  row B5 "Tải khi backup" "slice + site 200" FAIL "run=$(code "$b5") slice=$in_slice non200=$non200 slow=$slow worst=${worst}ms $quota"
fi
rm -f "$SITE_ROOT/public/assets/big.bin" "$SITE_ROOT/public/assets/big2.bin" /root/itso-vm8-b4.json /root/itso-vm8-b5.json

# ================================================================ B6 (chỉ ghi chú ở chế độ thường)
row B6 "DR 2 VM theo runbook" "panel + account khôi phục trên VM mới" SKIP "chạy --dr-source trên VM1, chép /root/itso-dr-kit.tar sang VM2 mới cài (install.sh --restore), rồi --dr-target"

[ "$FAIL" -eq 0 ]
