#!/usr/bin/env bash
# Chạy bộ test VM Phase 4 trên Multipass (máy dev có Multipass; KHÔNG dùng máy chủ thật).
#
#   make release                       # tạo build/release/<phiên bản>/
#   bash tests/vm/multipass.sh [--release build/release/<v>] [--release2 <thư mục>] [--keep] [--name itso-test]
#
# Tạo VM Ubuntu 24.04 (2 vCPU, 2 GB RAM, 20 GB), chép release + tests/vm, chạy run-all.sh bằng root,
# lấy báo cáo về build/vm-report.md, rồi xóa VM (trừ khi --keep).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME=itso-test REL="" REL2="" KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --release) REL="$2"; shift 2 ;;
    --release2) REL2="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --name) NAME="$2"; shift 2 ;;
    *) echo "tham số lạ: $1" >&2; exit 2 ;;
  esac
done
command -v multipass >/dev/null || { echo "cần multipass (https://multipass.run)" >&2; exit 2; }
if [ -z "$REL" ]; then
  REL=$(ls -d "$ROOT"/build/release/*/ 2>/dev/null | sort -V | tail -1)
fi
[ -f "${REL%/}/install.sh" ] || { echo "không thấy release (chạy make release hoặc --release)" >&2; exit 2; }

cleanup() { [ "$KEEP" = 1 ] || multipass delete --purge "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

multipass launch 24.04 --name "$NAME" --cpus 2 --memory 2G --disk 20G
multipass transfer -r "${REL%/}" "$NAME:/home/ubuntu/release"
multipass transfer -r "$ROOT/tests/vm" "$NAME:/home/ubuntu/vm"
ARGS=(--release /home/ubuntu/release --report /home/ubuntu/itso-vm-report.md)
if [ -n "$REL2" ]; then
  multipass transfer -r "${REL2%/}" "$NAME:/home/ubuntu/release2"
  ARGS+=(--release2 /home/ubuntu/release2)
fi
set +e
multipass exec "$NAME" -- sudo bash /home/ubuntu/vm/run-all.sh "${ARGS[@]}"
rc=$?
set -e
mkdir -p "$ROOT/build"
multipass exec "$NAME" -- sudo chown ubuntu /home/ubuntu/itso-vm-report.md || true
multipass transfer "$NAME:/home/ubuntu/itso-vm-report.md" "$ROOT/build/vm-report.md" && echo "Báo cáo: build/vm-report.md"
exit "$rc"
