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

mkrel "$T/dr"
if run "$T/dr" --restore --yes && grep -q "FAKE-ITSO install --release-dir $T/boot-dr --restore --yes" "$T/dr/ran" 2>/dev/null; then
  ok "--restore (khôi phục thảm họa) được chuyển nguyên cho itso install"
else ko "--restore: $(cat "$T/out")"; fi

mkrel "$T/node"
PIN=$(printf '%064d' 0 | tr 0 a)
if run "$T/node" --role node --join https://cp.itso.local:28444 --token itso_enr_abcdefghijklmnopqrstuvwxyz0123456789AB --ca-sha256 "$PIN" --yes \
  && grep -q "FAKE-ITSO install --release-dir $T/boot-node --role node --join https://cp.itso.local:28444 --token itso_enr_abcdefghijklmnopqrstuvwxyz0123456789AB --ca-sha256 $PIN --yes" "$T/node/ran" 2>/dev/null; then
  ok "--role node --join --token --ca-sha256 được chuyển nguyên cho itso install"
else ko "--role node: $(cat "$T/out")"; fi

mkrel "$T/cp"
if run "$T/cp" --role control-plane --yes && grep -q "FAKE-ITSO install --release-dir $T/boot-cp --role control-plane --yes" "$T/cp/ran" 2>/dev/null; then
  ok "--role control-plane được chuyển nguyên cho itso install"
else ko "--role control-plane: $(cat "$T/out")"; fi

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

echo "install.sh --offline + release-offline (bundle giả):"
# Bản phát hành giả + một .deb thật tối giản (dpkg-deb) → release-offline → install.sh --offline với repo/apt trong thư mục tạm.
mkrel "$T/orel"
printf '#!/usr/bin/env bash\n{ echo "FAKE-ITSO $*"; cat "$ITSO_APT_DIR/itso-offline.list" 2>/dev/null; ls "$ITSO_OFFLINE_REPO_DIR" 2>/dev/null; } > "%s/offline-ran"\n' "$T" > "$T/orel/itso"
sb=$(sha256sum "$T/orel/itso" | cut -d' ' -f1)
sed -i -E "s/(\"name\": \"itso\", \"kind\": \"binary\", \"sha256\": \")[0-9a-f]{64}/\1$sb/" "$T/orel/manifest.json"
openssl pkeyutl -sign -inkey "$T/key.pem" -rawin -in "$T/orel/manifest.json" -out "$T/orel/manifest.sig"
mkdir -p "$T/pkg/DEBIAN" "$T/cache"
printf 'Package: itso-fake\nVersion: 1.0-1\nArchitecture: all\nMaintainer: ITSO <ops@itso.invalid>\nDescription: gói giả cho test\n' > "$T/pkg/DEBIAN/control"
if command -v dpkg-deb >/dev/null && dpkg-deb --build --root-owner-group "$T/pkg" "$T/cache/itso-fake_1.0-1_all.deb" >/dev/null 2>&1; then
  dsum=$(sha256sum "$T/cache/itso-fake_1.0-1_all.deb" | cut -d' ' -f1)
  printf '# lock test\nitso-fake=1.0-1 %s itso-fake_1.0-1_all.deb\n' "$dsum" > "$T/lock"
  rel_off() { RELEASE_DIR="$T/orel" VERSION=1.0.0 ITSO_RELEASE_KEY="$T/key.pem" ITSO_OFFLINE_LOCK="$1" ITSO_DEB_CACHE="$T/cache" \
    bash scripts/release-offline.sh > "$T/out" 2>&1; }
  B="$T/orel/itso-1.0.0-offline.tar"
  if rel_off "$T/lock" && [ -f "$B" ] && tar -tf "$B" | grep -qx 'itso-1.0.0-offline/debs/itso-fake_1.0-1_all.deb' \
    && tar -xOf "$B" itso-1.0.0-offline/Packages | grep -q '^Package: itso-fake'; then
    ok "release-offline: .deb khớp lock + Packages + offline-manifest ký"
  else ko "release-offline: $(cat "$T/out")"; fi

  printf '# lock sai\nitso-fake=1.0-1 %064d itso-fake_1.0-1_all.deb\n' 0 > "$T/lock-bad"
  if ! rel_off "$T/lock-bad" && grep -q "KHÁC lock" "$T/out"; then ok "release-offline: sha256 .deb khác lock → dừng"; else ko "lock sai: $(cat "$T/out")"; fi
  rel_off "$T/lock" || true

  runoff() { # runoff <bundle> [args…]
    rm -f "$T/offline-ran"
    ITSO_OFFLINE_REPO_DIR="$T/repo" ITSO_APT_DIR="$T/apt" ITSO_BOOTSTRAP_DIR="$T/boot-off" bash "$T/install.sh" --offline "$@" > "$T/out" 2>&1
  }
  if runoff "$B" --yes && grep -q "^FAKE-ITSO install --release-dir $T/boot-off --offline --yes" "$T/offline-ran" \
    && grep -qx "deb \[trusted=yes\] file:$T/repo ./" "$T/offline-ran" && grep -qx 'itso-fake_1.0-1_all.deb' "$T/offline-ran" \
    && [ ! -e "$T/repo" ] && [ ! -e "$T/apt/itso-offline.list" ]; then
    ok "--offline: kiểm chữ ký + sha → repo apt tạm cho itso install --offline → xóa repo sau cài"
  else ko "--offline: $(cat "$T/out"; cat "$T/offline-ran" 2>/dev/null)"; fi

  if runoff "$B" --keep-offline-repo --yes && [ -f "$T/repo/Packages" ] && [ -f "$T/apt/sources.list.d/itso-offline.list" ] && [ ! -e "$T/apt/itso-offline.list" ]; then
    ok "--keep-offline-repo: giữ repo, đăng ký vào sources.list.d (Wizard cài stack từ bundle)"
  else ko "--keep-offline-repo: $(cat "$T/out")"; fi
  rm -rf "$T/repo" "$T/apt"

  # Bundle bị sửa: giải nén → đổi → đóng lại.
  retar() { # retar <tên> <lệnh sửa trong thư mục bundle>
    rm -rf "$T/x" && mkdir -p "$T/x" && tar -C "$T/x" -xf "$B" && (cd "$T/x/itso-1.0.0-offline" && eval "$2") && tar -C "$T/x" -cf "$T/$1.tar" itso-1.0.0-offline
  }
  retar deb 'echo x >> debs/itso-fake_1.0-1_all.deb'
  if ! runoff "$T/deb.tar" && grep -q "sha256 trong bundle offline sai" "$T/out" && [ ! -e "$T/offline-ran" ]; then ok "--offline: .deb bị thay → từ chối"; else ko ".deb bị thay: $(cat "$T/out")"; fi
  retar extra 'cp debs/itso-fake_1.0-1_all.deb debs/evil_1.0_all.deb'
  if ! runoff "$T/extra.tar" && grep -q "gói ngoài danh sách đã ký" "$T/out"; then ok "--offline: .deb ngoài danh sách ký → từ chối"; else ko "deb thừa: $(cat "$T/out")"; fi
  retar rel 'echo " " >> manifest.json'
  if ! runoff "$T/rel.tar" && grep -q "sha256 trong bundle offline sai" "$T/out"; then ok "--offline: manifest.json của release bị đổi → từ chối"; else ko "manifest đổi: $(cat "$T/out")"; fi
  retar sig "openssl pkeyutl -sign -inkey '$T/k2.pem' -rawin -in offline-manifest.json -out offline-manifest.sig"
  if ! runoff "$T/sig.tar" && grep -q "chữ ký offline-manifest KHÔNG hợp lệ" "$T/out"; then ok "--offline: offline-manifest ký khóa khác → từ chối"; else ko "ký khác: $(cat "$T/out")"; fi
  retar link 'ln -s /etc/shadow debs/shadow.deb'
  if ! runoff "$T/link.tar" && grep -q "mục không hợp lệ" "$T/out"; then ok "--offline: symlink trong bundle → từ chối trước khi giải nén"; else ko "symlink: $(cat "$T/out")"; fi
else
  ko "không dựng được .deb giả (cần dpkg-deb)"
fi

echo "install.sh: $pass đạt, $fail lỗi"
[ "$fail" -eq 0 ]
