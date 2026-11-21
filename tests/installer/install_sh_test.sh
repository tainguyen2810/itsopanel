#!/usr/bin/env bash
# Test install.sh (bash thuần, kiểu bats): chữ ký đúng → chạy `itso install`; chữ ký sai, sha sai,
# OS sai, phiên bản lạ, không phải root → dừng trước khi chạy gì. Không đụng hệ thống: mọi file trong thư mục tạm.
set -uo pipefail
cd "$(dirname "$0")/../.."
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ✓ $1"; }
ko() { fail=$((fail+1)); echo "  ✗ $1"; }

openssl genpkey -algorithm ed25519 -out "$T/key.pem" 2>/dev/null
openssl pkey -in "$T/key.pem" -pubout -out "$T/pub.pem"
python3 - "$T/pub.pem" > "$T/install.sh" <<'PY'
import sys
s = open("packaging/install.sh.in").read()
s = s.replace("@PUBKEY_PEM@", open(sys.argv[1]).read().strip()).replace("@VERSION@", "1.0.0").replace("@RELEASE_URL@", "https://invalid.example")
sys.stdout.write(s)
PY

mkrel() { # mkrel <dir>: bản phát hành giả, itso giả ghi lại argv
  local d=$1; mkdir -p "$d"
  printf '#!/usr/bin/env bash\necho "FAKE-ITSO $*" > "%s/ran"\n' "$d" > "$d/itso"
  echo "tarball" > "$d/itso-1.0.0-linux-amd64.tar.gz"
  local sb st
  sb=$(sha256sum "$d/itso" | cut -d' ' -f1); st=$(sha256sum "$d/itso-1.0.0-linux-amd64.tar.gz" | cut -d' ' -f1)
  printf '{"name": "itso-panel", "version": "1.0.0", "artifacts": [{"name": "itso-1.0.0-linux-amd64.tar.gz", "kind": "tarball", "sha256": "%s", "size": 8}, {"name": "itso", "kind": "binary", "sha256": "%s", "size": 1}]}\n' "$st" "$sb" > "$d/manifest.json"
  openssl pkeyutl -sign -inkey "$T/key.pem" -rawin -in "$d/manifest.json" -out "$d/manifest.sig"
}
run() { # run <release dir> [args…] → in exit code và output
  ITSO_RELEASE_DIR="$1" ITSO_BOOTSTRAP_DIR="$T/boot-$(basename "$1")" bash "$T/install.sh" "${@:2}" > "$T/out" 2>&1
}

echo "install.sh:"
mkrel "$T/good"
if run "$T/good" --port 30000 --yes && grep -q "FAKE-ITSO install --release-dir $T/boot-good --port 30000 --yes" "$T/good/ran" 2>/dev/null; then
  ok "chữ ký + sha đúng → chạy itso install với tham số"
else ko "trường hợp đúng: $(cat "$T/out")"; fi

mkrel "$T/badsig"; printf 'x' >> "$T/badsig/manifest.json"
if ! run "$T/badsig" && grep -q "chữ ký manifest KHÔNG hợp lệ" "$T/out" && [ ! -e "$T/badsig/ran" ]; then ok "manifest bị sửa → từ chối"; else ko "chữ ký sai: $(cat "$T/out")"; fi

mkrel "$T/othersig"; openssl genpkey -algorithm ed25519 -out "$T/k2.pem" 2>/dev/null
openssl pkeyutl -sign -inkey "$T/k2.pem" -rawin -in "$T/othersig/manifest.json" -out "$T/othersig/manifest.sig"
if ! run "$T/othersig" && grep -q "chữ ký manifest KHÔNG hợp lệ" "$T/out"; then ok "ký bằng khóa khác → từ chối"; else ko "khóa khác: $(cat "$T/out")"; fi

mkrel "$T/badbin"; echo "echo pwned" >> "$T/badbin/itso"
if ! run "$T/badbin" && grep -q "sha256 của itso sai" "$T/out" && [ ! -e "$T/badbin/ran" ]; then ok "binary itso bị thay → từ chối"; else ko "sha binary: $(cat "$T/out")"; fi

mkrel "$T/badtar"; echo "more" >> "$T/badtar/itso-1.0.0-linux-amd64.tar.gz"
if ! run "$T/badtar" && grep -q "sha256 của itso-1.0.0-linux-amd64.tar.gz sai" "$T/out"; then ok "tarball bị thay → từ chối"; else ko "sha tarball: $(cat "$T/out")"; fi

if ! run "$T/good" --version '1.0;rm' && grep -q "phiên bản không hợp lệ" "$T/out"; then ok "phiên bản có ký tự lạ → từ chối"; else ko "version: $(cat "$T/out")"; fi

printf 'ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Debian 12"\n' > "$T/os-release"
if ! ITSO_OS_RELEASE="$T/os-release" run "$T/good" && grep -q "chỉ hỗ trợ Ubuntu 24.04" "$T/out"; then ok "OS khác Ubuntu 24.04 → từ chối"; else ko "OS: $(cat "$T/out")"; fi

if [ "$(id -u)" -eq 0 ] && command -v setpriv >/dev/null; then
  chmod 0755 "$T"; chmod 0644 "$T/install.sh"
  if ! setpriv --reuid=65534 --regid=65534 --clear-groups bash "$T/install.sh" > "$T/out" 2>&1 && grep -q "cần chạy bằng root" "$T/out"; then
    ok "không phải root → từ chối"; else ko "root: $(cat "$T/out")"; fi
fi

echo "install.sh: $pass đạt, $fail lỗi"
[ "$fail" -eq 0 ]
