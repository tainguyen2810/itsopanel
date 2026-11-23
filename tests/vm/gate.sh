#!/usr/bin/env bash
# Production Gate G1–G8 (Prompt 12.8, D-47, D-115) — chạy bằng root trên VM Ubuntu 24.04 ĐÃ CÀI ITSO bản --release
# (run-all.sh --no-uninstall), dùng một lần. KHÔNG chạy trên máy thật: script tạo account thử, thử leo quyền, nâng/hạ
# phiên bản, và (khi có --allow-uninstall) gỡ panel.
#
#   sudo bash tests/vm/gate.sh --release A --release2 B --release3 C [--only G1,G3] [--node-report F]
#                              [--g4-report F] [--g6-report F] [--g7-report F] [--allow-uninstall] [--record]
#
# Mỗi bài Gate gom kết quả bộ VM của từng Phase (bảng Markdown của chúng) + kiểm riêng của Gate, ghi docs-ready
# vào $REPORT (mặc định /root/itso-vm-gate.md). Tiêu chí đầy đủ, phần đã kiểm tự động trong CI và bước tay: docs/gate/G<n>.md.
#   G1 cách ly: enforcement.sh E5–E8 trên máy này + báo cáo cùng script chạy trên server thứ hai (--node-report);
#      thiếu server thứ hai → partial
#   G2 quota: enforcement.sh E1–E4 (E4 cần quota kernel; chỉ đo → partial)
#   G3 leo quyền: từ UID account (webshell) đọc bí mật/agent socket/sudo/setuid; giả định Laravel bị RCE (có khóa HMAC
#      của panel): agent từ chối op lạ, tham số traversal, uid 0, account ngoài tiền tố; Portal: ma trận quyền Pest (CI)
#   G4 khôi phục: phase8.sh B1–B3 trên máy này + báo cáo 10 lần khôi phục ngẫu nhiên/khác server (--g4-report)
#   G5 nâng cấp: A → B → C, rollback giữa chừng (C → B) rồi C lại; site account 0 lỗi HTTP suốt quá trình
#   G6 DR: báo cáo phase8.sh --dr-target (--g6-report) + khôi phục cả server sang máy khác (bước tay G6.md)
#   G7 chuyển account: báo cáo phase9.sh --panel-2 có ≥ 5 lượt chuyển (--g7-report)
#   G8 gỡ cài đặt (chỉ với --allow-uninstall, chạy cuối): site 200, /home và DB còn nguyên
# --record: ghi trạng thái từng bài vào panel (php artisan itso:gate-record) — trang Sẵn sàng production đọc lại.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

REPORT="${REPORT:-/root/itso-vm-gate.md}"
REL="" REL2="" REL3="" ONLY="G1,G2,G3,G4,G5,G6,G7,G8" NODE_REPORT="" G4R="" G6R="" G7R="" UNINSTALL=0 RECORD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --release) REL="$2"; shift 2 ;;
    --release2) REL2="$2"; shift 2 ;;
    --release3) REL3="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --node-report) NODE_REPORT="$2"; shift 2 ;;
    --g4-report) G4R="$2"; shift 2 ;;
    --g6-report) G6R="$2"; shift 2 ;;
    --g7-report) G7R="$2"; shift 2 ;;
    --allow-uninstall) UNINSTALL=1; shift ;;
    --record) RECORD=1; shift ;;
    --report) REPORT="$2"; shift 2 ;;
    *) echo "tham số lạ: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "cần root (VM test)" >&2; exit 2; }
command -v itso >/dev/null && [ -S /run/itso/agent.sock ] || { echo "chưa cài ITSO (run-all.sh --no-uninstall trước)" >&2; exit 2; }
ST=/root/itso-vm-gate
mkdir -p "$ST" && chmod 0700 "$ST"
trap write_report EXIT
want() { [[ ",$ONLY," == *",$1,"* ]]; }
declare -A VERDICT

# st <báo cáo> <mã> → PASS|FAIL|SKIP|WARN|MISSING (đọc bảng của bộ VM Phase).
st() { [ -f "$1" ] || { echo MISSING; return; }; grep -E "^\| $2 \|" "$1" | head -n1 | grep -oE '\*\*(PASS|FAIL|SKIP|WARN)\*\*' | tr -d '*' || true; }
# all_pass <báo cáo> <mã…> → 0 nếu mọi mã PASS
all_pass() { local f="$1" c s; shift; for c in "$@"; do s=$(st "$f" "$c"); [ "$s" = PASS ] || return 1; done; }
gate() { # gate <G> <pass|fail|partial> <chi tiết>
  VERDICT[$1]=$2
  case "$2" in pass) row "$1" "$(gate_title "$1")" "đạt tiêu chí docs/gate/$1.md" PASS "$3" ;;
    fail) row "$1" "$(gate_title "$1")" "đạt tiêu chí docs/gate/$1.md" FAIL "$3" ;;
    *) row "$1" "$(gate_title "$1")" "đạt tiêu chí docs/gate/$1.md" WARN "partial: $3" ;; esac
}
gate_title() {
  case "$1" in G1) echo "Cách ly account (≥ 2 server)" ;; G2) echo "Quota" ;; G3) echo "Leo thang đặc quyền" ;;
    G4) echo "Backup/Restore" ;; G5) echo "Nâng cấp 3 phiên bản" ;; G6) echo "Disaster recovery" ;; G7) echo "Chuyển account" ;;
    G8) echo "Gỡ cài đặt" ;; esac
}

# ------------------------------------------------------------ G1 + G2 (enforcement.sh)
ENF="$ST/enforcement.md"
if want G1 || want G2; then
  REPORT="$ENF" bash "$VM_DIR/enforcement.sh" >/dev/null 2>&1 || true
fi
if want G1; then
  if all_pass "$ENF" E5 E6 E7 E8; then
    if [ -n "$NODE_REPORT" ] && all_pass "$NODE_REPORT" E5 E6 E7 E8; then
      gate G1 pass "E5–E8 PASS trên máy này và trên server thứ hai ($NODE_REPORT)"
    else
      gate G1 partial "E5–E8 PASS trên máy này; chưa có báo cáo server thứ hai (--node-report)"
    fi
  else
    gate G1 fail "E5 $(st "$ENF" E5), E6 $(st "$ENF" E6), E7 $(st "$ENF" E7), E8 $(st "$ENF" E8) (xem $ENF)"
  fi
fi
if want G2; then
  if all_pass "$ENF" E1 E2 E3 E4; then gate G2 pass "E1–E4 PASS (CPU, RAM, tasks, disk EDQUOT)"
  elif all_pass "$ENF" E1 E2 E3 && [ "$(st "$ENF" E4)" = WARN ]; then gate G2 partial "E1–E3 PASS; E4 không có quota kernel (bật usrjquota)"
  else gate G2 fail "E1 $(st "$ENF" E1), E2 $(st "$ENF" E2), E3 $(st "$ENF" E3), E4 $(st "$ENF" E4) (xem $ENF)"; fi
fi

# ------------------------------------------------------------ G3 leo quyền
if want G3; then
  bad=()
  id itsoa >/dev/null 2>&1 || REPORT="$ENF" bash "$VM_DIR/enforcement.sh" >/dev/null 2>&1 || true
  SL="itso-acct-$(id -u itsoa 2>/dev/null).slice"
  try_acct() { as_acct itsoa "$SL" sh -c "$1" >/dev/null 2>&1; }
  try_acct 'cat /etc/shadow' && bad+=("account đọc được /etc/shadow")
  try_acct 'cat /etc/itso/agent.key' && bad+=("account đọc được agent.key")
  try_acct 'cat /etc/itso/itso.env' && bad+=("account đọc được itso.env")
  try_acct 'python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect(\"/run/itso/agent.sock\")"' && bad+=("account kết nối được agent socket")
  try_acct 'sudo -n true' && bad+=("account sudo được")
  try_acct 'touch /opt/itso/current/pwn' && bad+=("account ghi được /opt/itso")
  try_acct 'touch /etc/nginx/sites-enabled/pwn' && bad+=("account ghi được cấu hình nginx")
  w=$(find / -xdev -perm -4000 -type f -writable 2>/dev/null | head -n3)
  [ -z "$w" ] || bad+=("file setuid ghi được: $w")
  # Giả định Laravel bị RCE: kẻ tấn công có khóa HMAC của panel (agent_call.py dùng chính khóa đó).
  code() { jget "$1" 'd["body"]["error"]["code"] if d["body"] and not d["body"].get("ok") else "ok"'; }
  [ "$(code "$(agent system.exec '{"cmd":"id"}')")" = unknown_op ] || bad+=("agent nhận op system.exec")
  [ "$(code "$(agent fs.read '{"account":{"username":"itsoa","uid":'"$(id -u itsoa)"'},"path":"../../../etc/shadow","max_bytes":4096}')")" = invalid_params ] || bad+=("fs.read traversal không bị từ chối invalid_params")
  [ "$(code "$(agent account.ensure '{"account":{"username":"rootx","uid":0},"home_path":"/root","shell":"/bin/bash","limits":{"disk_mb":1,"inode_limit":1,"cpu_percent":1,"ram_mb":64,"tasks_max":16,"io_weight":1,"io_read_bps":null,"io_write_bps":null}}')")" = invalid_params ] \
    || bad+=("account.ensure uid 0 không bị từ chối invalid_params")
  [ "$(code "$(agent account.ensure '{"account":{"username":"itso","uid":20099},"home_path":"/etc","shell":"/bin/bash","limits":{"disk_mb":1,"inode_limit":1,"cpu_percent":1,"ram_mb":64,"tasks_max":16,"io_weight":1,"io_read_bps":null,"io_write_bps":null}}')")" != ok ] \
    || bad+=("account.ensure nhận user hệ thống/home ngoài /home")
  if [ ${#bad[@]} -eq 0 ]; then
    gate G3 partial "webshell + Laravel RCE: 12 thử nghiệm bị chặn; Portal → ma trận quyền Pest (CI); còn pentest độc lập (D-50)"
  else
    gate G3 fail "${bad[*]}"
  fi
fi

# ------------------------------------------------------------ G4 khôi phục
if want G4; then
  P8="$ST/phase8.md"
  REPORT="$P8" bash "$VM_DIR/phase8.sh" --report "$P8" >/dev/null 2>&1 || true
  if all_pass "$P8" B1 B2 B3; then
    if [ -n "$G4R" ] && grep -q 'restores=10' "$G4R" && grep -q 'cross_server=PASS' "$G4R" && ! grep -q '\*\*FAIL\*\*' "$G4R"; then
      gate G4 pass "B1–B3 PASS (restore file/DB, append-only không xóa được); 10 lần ngẫu nhiên + khác server ($G4R)"
    else
      gate G4 partial "B1–B3 PASS; cần báo cáo 10 lần khôi phục ngẫu nhiên + 1 sang server khác (--g4-report, docs/gate/G4.md)"
    fi
  else
    gate G4 fail "B1 $(st "$P8" B1), B2 $(st "$P8" B2), B3 $(st "$P8" B3) (xem $P8)"
  fi
fi

# ------------------------------------------------------------ G5 nâng cấp 3 phiên bản
if want G5; then
  if [ -f "$REL/manifest.json" ] && [ -f "$REL2/manifest.json" ] && [ -f "$REL3/manifest.json" ]; then
    vof() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$1/manifest.json"; }
    V1=$(vof "$REL") V2=$(vof "$REL2") V3=$(vof "$REL3")
    ver() { itso version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?' | head -n1; }
    SITE=$(cat /root/itso-vm-upgrade/site 2>/dev/null || true)
    log="$ST/g5.log"; : > "$ST/g5-site.log"
    if [ -n "$SITE" ]; then
      ( while :; do curl -s -o /dev/null -w '%{http_code}\n' --max-time 2 --resolve "$SITE:80:127.0.0.1" "http://$SITE/" >> "$ST/g5-site.log"; sleep 0.2; done ) &
      PROBE=$!
    fi
    path=""
    itso update --release-dir "$REL2" >>"$log" 2>&1; path+="$(ver)"
    itso update --release-dir "$REL3" >>"$log" 2>&1; path+=" → $(ver)"
    itso rollback >>"$log" 2>&1; path+=" → rollback $(ver)"
    itso update --release-dir "$REL3" >>"$log" 2>&1; path+=" → $(ver)"
    [ -n "${PROBE:-}" ] && kill "$PROBE" 2>/dev/null
    bad=$(grep -cv '^200$' "$ST/g5-site.log" 2>/dev/null || echo 0)
    if [ "$path" = "$V2 → $V3 → rollback $V2 → $V3" ] && itso doctor >/dev/null 2>&1; then
      if [ -n "$SITE" ] && [ "$bad" -eq 0 ]; then gate G5 pass "$V1 → $path; site $SITE 0 lỗi HTTP ($(wc -l < "$ST/g5-site.log") yêu cầu)"
      elif [ -z "$SITE" ]; then gate G5 partial "$V1 → $path; chưa đo site (chạy upgrade-loop.sh trước để có site vm12)"
      else gate G5 fail "$V1 → $path; site lỗi $bad lần"; fi
    else
      gate G5 fail "đường nâng cấp: $V1 → $path (xem $log)"
    fi
  else
    gate G5 fail "cần --release, --release2, --release3 (ba bản liên tiếp)"
  fi
fi

# ------------------------------------------------------------ G6, G7 (báo cáo của bộ nhiều VM)
if want G6; then
  if [ -n "$G6R" ] && [ "$(st "$G6R" B6)" = PASS ] && grep -q 'server_restore=PASS' "$G6R"; then
    gate G6 pass "DR control plane (B6) + khôi phục cả server ($G6R)"
  elif [ -n "$G6R" ] && [ "$(st "$G6R" B6)" = PASS ]; then
    gate G6 partial "DR control plane B6 PASS; chưa có khôi phục cả server sang máy khác (docs/gate/G6.md §VM)"
  else
    gate G6 partial "cần báo cáo phase8.sh --dr-target trên VM thứ hai (--g6-report)"
  fi
fi
if want G7; then
  if [ -n "$G7R" ] && all_pass "$G7R" N4 N5 && [ "$(grep -cE '^\| N4[a-z0-9-]* \|.*\*\*PASS\*\*' "$G7R")" -ge 5 ]; then
    gate G7 pass "≥ 5 lượt chuyển PASS + rollback ($G7R)"
  elif [ -n "$G7R" ] && all_pass "$G7R" N4 N5; then
    gate G7 partial "N4 + N5 PASS nhưng chưa đủ 5 lượt chuyển (docs/gate/G7.md)"
  else
    gate G7 partial "cần báo cáo phase9.sh --panel-2 (--g7-report)"
  fi
fi

# ------------------------------------------------------------ ghi kết quả vào panel (trước G8)
if [ "$RECORD" = 1 ]; then
  for g in "${!VERDICT[@]}"; do
    setpriv --reuid=itso --regid="$(id -g itso)" --init-groups frankenphp php-cli /opt/itso/current/api/artisan \
      itso:gate-record "$g" "${VERDICT[$g]}" --note "tests/vm/gate.sh $(date -I)" --no-interaction >/dev/null 2>&1 || true
  done
fi

# ------------------------------------------------------------ G8 gỡ cài đặt (cuối cùng)
if want G8; then
  if [ "$UNINSTALL" = 1 ]; then
    SITE=$(cat /root/itso-vm-upgrade/site 2>/dev/null || echo "")
    homes0=$(find /home -mindepth 1 -maxdepth 1 -type d | wc -l)
    dbs0=$(mysql -N -e 'SHOW DATABASES' 2>/dev/null | grep -vcE '^(information_schema|performance_schema|mysql|sys)$')
    itso uninstall > "$ST/uninstall.log" 2>&1; rc=$?
    homes1=$(find /home -mindepth 1 -maxdepth 1 -type d | wc -l)
    dbs1=$(mysql -N -e 'SHOW DATABASES' 2>/dev/null | grep -vcE '^(information_schema|performance_schema|mysql|sys)$')
    code=$([ -n "$SITE" ] && curl -s -o /dev/null -w '%{http_code}' --resolve "$SITE:80:127.0.0.1" "http://$SITE/" || echo none)
    if [ $rc -eq 0 ] && [ "$homes0" = "$homes1" ] && [ "$dbs0" = "$dbs1" ] && [ "$code" = 200 ] && ! systemctl is-active -q itso.target; then
      gate G8 pass "gỡ xong; /home $homes1 thư mục, $dbs1 DB giữ nguyên; site $SITE 200 (ghi tay itso:gate-record G8 pass sau khi cài lại)"
    else
      gate G8 fail "rc $rc; /home $homes0→$homes1; DB $dbs0→$dbs1; site $code (xem $ST/uninstall.log)"
    fi
  else
    gate G8 partial "chưa chạy (cần --allow-uninstall; gỡ panel khỏi VM này)"
  fi
fi
[ "$FAIL" -eq 0 ]
