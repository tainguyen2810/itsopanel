#!/usr/bin/env bash
# Bảng enforcement 07-HOSTING-ISOLATION §9 trên VM đã cài ITSO (root). Gọi từ run-all.sh hoặc chạy riêng:
#   sudo bash tests/vm/enforcement.sh        → ghi REPORT (mặc định /root/itso-vm-report.md)
# Tạo 2 account thử (itsoa 20001, itsob 20002) qua agent thật: account.ensure + account.limits.apply + quota.apply.
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
[ "${ENF_STANDALONE:-1}" = 1 ] && trap write_report EXIT

LIMITS='{"disk_mb":200,"inode_limit":20000,"cpu_percent":100,"ram_mb":256,"tasks_max":64,"io_weight":100,"io_read_bps":null,"io_write_bps":null}'
CG=/sys/fs/cgroup/itso.slice/itso-acct.slice

make_account() {
  local user="$1" uid="$2" r ok
  r=$(agent account.ensure "{\"account\":{\"username\":\"$user\",\"uid\":$uid},\"home_path\":\"/home/$user\",\"shell\":\"/bin/bash\",\"limits\":$LIMITS}")
  ok=$(jget "$r" 'd["body"]["ok"]')
  for op in account.limits.apply quota.apply; do
    r=$(agent "$op" "{\"account\":{\"username\":\"$user\",\"uid\":$uid},\"limits\":$LIMITS}")
    [ "$(jget "$r" 'd["body"]["ok"]')" = True ] || ok="False ($op: $(jget "$r" 'd["body"]["error"]'))"
  done
  echo "$ok"
}

A_OK=$(make_account itsoa 20001)
B_OK=$(make_account itsob 20002)
if [ "$A_OK" = True ] && [ "$B_OK" = True ]; then
  row E0 "Tạo 2 account qua agent (ensure + limits + quota)" "ok" PASS "itsoa 20001, itsob 20002; CPU 100%, RAM 256 MB, tasks 64, disk 200 MB"
else
  row E0 "Tạo 2 account qua agent" "ok" FAIL "itsoa: $A_OK; itsob: $B_OK"
fi
SA=itso-acct-20001.slice
SB=itso-acct-20002.slice
# Giữ slice sống suốt bộ test (slice rỗng bị systemd dọn, mất cpu.stat/memory.events để đọc).
as_acct itsoa "$SA" sleep 900 >/dev/null 2>&1 &
HOLD_A=$!
as_acct itsob "$SB" sleep 900 >/dev/null 2>&1 &
HOLD_B=$!
cleanup_hold() { systemctl stop "$SA" "$SB" >/dev/null 2>&1; kill "$HOLD_A" "$HOLD_B" 2>/dev/null; }
sleep 2
QMODE=$(jget "$(agent system.info '{}')" 'd["body"]["data"]["quota_mode"]')

# E1 CPU: stress-ng --cpu 8 trong account CPU 100% → throttled, ≤ ~1 core.
if command -v stress-ng >/dev/null; then
  as_acct itsoa "$SA" stress-ng --cpu 8 --timeout 25s --quiet >/dev/null 2>&1 &
  sleep 3
  before=$(awk '/usage_usec/{print $2}' "$CG/$SA/cpu.stat" 2>/dev/null || echo 0)
  sleep 15
  after=$(awk '/usage_usec/{print $2}' "$CG/$SA/cpu.stat" 2>/dev/null || echo 0)
  thr=$(awk '/nr_throttled/{print $2}' "$CG/$SA/cpu.stat" 2>/dev/null || echo 0)
  wait "$!" 2>/dev/null
  cores=$(python3 -c "print(round(($after-$before)/15e6,2))")
  if [ "$thr" -gt 0 ] && python3 -c "import sys; sys.exit(0 if $cores <= 1.2 else 1)"; then
    row E1 "stress-ng --cpu 8, CPU 100%" "throttled, ≤ ~1 core" PASS "nr_throttled=$thr, trung bình $cores core"
  else
    row E1 "stress-ng --cpu 8, CPU 100%" "throttled, ≤ ~1 core" FAIL "nr_throttled=$thr, trung bình $cores core"
  fi
else
  row E1 "stress-ng --cpu 8" "throttled" SKIP "chưa cài stress-ng (recipe stress-ng)"
fi

# E2 RAM vượt MemoryMax → OOM-kill trong slice, agent và account khác không ảnh hưởng.
oom0=$(awk '/oom_kill /{print $2}' "$CG/$SA/memory.events" 2>/dev/null || echo 0)
as_acct itsoa "$SA" python3 -c "x=bytearray(600*1024*1024); import time; time.sleep(2)" >/dev/null 2>&1
rc=$?
oom1=$(awk '/oom_kill /{print $2}' "$CG/$SA/memory.events" 2>/dev/null || echo 0)
agent_ok=$(systemctl is-active itso-agent)
b_ok=$(as_acct itsob "$SB" true && echo ok)
if [ "$rc" -ne 0 ] && [ "$oom1" -gt "$oom0" ] && [ "$agent_ok" = active ] && [ "$b_ok" = ok ]; then
  row E2 "Cấp phát 600 MB với MemoryMax 256 MB" "OOM-kill trong slice; agent, account B vẫn chạy" PASS "exit $rc, oom_kill $oom0→$oom1, agent $agent_ok, itsob $b_ok"
else
  row E2 "Cấp phát 600 MB với MemoryMax 256 MB" "OOM-kill trong slice" FAIL "exit $rc, oom_kill $oom0→$oom1, agent $agent_ok, itsob ${b_ok:-lỗi}"
fi

# E3 Fork bomb dừng ở TasksMax.
as_acct itsoa "$SA" bash -c 'for i in $(seq 1 300); do sleep 20 & done 2>/dev/null; wait' >/dev/null 2>&1 &
BOMB=$!
sleep 3
pids=$(cat "$CG/$SA/pids.current" 2>/dev/null || echo "?")
pmax=$(awk '/max/{print $2}' "$CG/$SA/pids.events" 2>/dev/null || echo 0)
wait "$BOMB"
if [ "$pids" != "?" ] && [ "$pids" -le 64 ] && [ "$pmax" -gt 0 ]; then
  row E3 "Fork bomb (300 tiến trình)" "dừng ở TasksMax=64" PASS "pids.current=$pids, pids.events max=$pmax"
else
  row E3 "Fork bomb (300 tiến trình)" "dừng ở TasksMax=64" FAIL "pids.current=$pids, pids.events max=$pmax"
fi

# E4 dd vượt disk hard → EDQUOT (chỉ ở quota kernel).
out=$(as_acct itsoa "$SA" dd if=/dev/zero of=/home/itsoa/sites/big.bin bs=1M count=400 2>&1)
rc=$?
rm -f /home/itsoa/sites/big.bin
if [ "$QMODE" != kernel ]; then
  row E4 "dd 400 MB với disk 200 MB" "EDQUOT" WARN "quota_mode=$QMODE: không có quota kernel, chỉ đo + cảnh báo (bật usrjquota rồi chạy lại)"
elif [ "$rc" -ne 0 ] && grep -qi "quota" <<<"$out"; then
  row E4 "dd 400 MB với disk 200 MB" "EDQUOT" PASS "$(tail -n1 <<<"$out")"
else
  row E4 "dd 400 MB với disk 200 MB" "EDQUOT" FAIL "exit $rc: $(tail -n1 <<<"$out")"
fi

# E5 Account A ls /home/B → Permission denied.
out=$(as_acct itsoa "$SA" ls /home/itsob 2>&1)
rc=$?
if [ "$rc" -ne 0 ] && grep -q "Permission denied" <<<"$out"; then
  row E5 "itsoa: ls /home/itsob" "Permission denied" PASS "$out"
else
  row E5 "itsoa: ls /home/itsob" "Permission denied" FAIL "exit $rc: $out"
fi

# E6 PHP account A đọc file của B → thất bại.
echo "bi-mat-cua-b" >/home/itsob/sites/secret.txt && chown itsob:itsob /home/itsob/sites/secret.txt
if command -v php >/dev/null; then
  out=$(as_acct itsoa "$SA" php -r 'var_dump(@file_get_contents("/home/itsob/sites/secret.txt"));' 2>&1)
  if grep -q "bool(false)" <<<"$out"; then
    row E6 "PHP itsoa đọc /home/itsob/sites/secret.txt" "thất bại" PASS "$out"
  else
    row E6 "PHP itsoa đọc file của itsob" "thất bại" FAIL "$out"
  fi
else
  out=$(as_acct itsoa "$SA" cat /home/itsob/sites/secret.txt 2>&1)
  if grep -q "Permission denied" <<<"$out"; then
    row E6 "itsoa đọc file của itsob (chưa có PHP: dùng cat)" "thất bại" PASS "$out — PHP-FPM cài ở Phase 5"
  else
    row E6 "itsoa đọc file của itsob" "thất bại" FAIL "$out"
  fi
fi

# E7 ps aux từ account A → chỉ thấy tiến trình của A (/proc hidepid=invisible).
# (tiến trình giữ slice của itsob đang chạy: itsoa không được thấy nó)
others=$(as_acct itsoa "$SA" ps -eo user= 2>/dev/null | sort -u | grep -v -x itsoa | tr '\n' ' ')
if [ -z "$others" ]; then
  row E7 "itsoa: ps aux" "chỉ thấy tiến trình của itsoa" PASS "không thấy user khác"
else
  row E7 "itsoa: ps aux" "chỉ thấy tiến trình của itsoa" FAIL "thấy: $others"
fi

# E8 sudo -l -U itso rỗng.
out=$(sudo -l -U itso 2>&1)
if grep -q "is not allowed to run sudo" <<<"$out"; then
  row E8 "sudo -l -U itso" "rỗng" PASS "$out"
else
  row E8 "sudo -l -U itso" "rỗng" FAIL "$out"
fi

cleanup_hold
