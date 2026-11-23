#!/usr/bin/env bash
# make release-offline (D-113, ADR 0058): đóng gói bản phát hành + .deb khóa phiên bản thành một tar cài không mạng:
#   build/release/<ver>/itso-<ver>-offline.tar
#     itso-<ver>-offline/{manifest.json,manifest.sig,itso,itso-<ver>-linux-<arch>.tar.gz,install.sh,sbom.json,release.pub.pem}
#     itso-<ver>-offline/debs/*.deb, Packages (chỉ mục apt), offline-manifest.json + offline-manifest.sig (Ed25519, cùng khóa release)
#
#   bash scripts/release-offline.sh                 dùng packaging/offline-packages.lock (sha256 phải khớp từng .deb)
#   bash scripts/release-offline.sh --update-lock   (Ubuntu 24.04 có mạng) tính bao đóng phụ thuộc của
#                                                   packaging/offline-packages.list, tải .deb, ghi lại lock
#
# Biến: VERSION, ARCH, RELEASE_DIR (bản release có sẵn; mặc định build/release/<ver>, chưa có thì chạy make release),
# ITSO_RELEASE_KEY (PEM Ed25519; không đặt → khóa DEV như release.sh), ITSO_OFFLINE_LOCK, ITSO_DEB_CACHE (thư mục .deb đã
# tải, mặc định build/offline-debs). Không bao giờ dùng .deb có sha256 khác lock.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
VER="${VERSION:-0.5.0-beta}"
ARCH="${ARCH:-amd64}"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "VERSION không hợp lệ: $VER" >&2; exit 1; }
REL="${RELEASE_DIR:-$ROOT/build/release/$VER}"
LOCK="${ITSO_OFFLINE_LOCK:-$ROOT/packaging/offline-packages.lock}"
LIST="${ITSO_OFFLINE_LIST:-$ROOT/packaging/offline-packages.list}"
CACHE="${ITSO_DEB_CACHE:-$ROOT/build/offline-debs}"
die() { echo "release-offline: $*" >&2; exit 1; }

if [ "${1:-}" = "--update-lock" ]; then
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || die "--update-lock cần Ubuntu 24.04 (đang là ${PRETTY_NAME:-?})"
  [ "$(dpkg --print-architecture)" = "$ARCH" ] || die "--update-lock cần máy $ARCH"
  mkdir -p "$CACHE"
  mapfile -t roots < <(grep -Ev '^\s*(#|$)' "$LIST")
  mapfile -t pkgs < <(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces \
    --no-enhances "${roots[@]}" | grep -E '^[a-z0-9][a-z0-9.+-]*$' | sort -u)
  tmp=$(mktemp)
  {
    head -n2 "$LOCK"
    for p in "${pkgs[@]}"; do
      v=$(apt-cache policy "$p" | awk '/Candidate:/{print $2}')
      [ -n "$v" ] && [ "$v" != "(none)" ] || continue
      (cd "$CACHE" && apt-get download -q "$p=$v" >/dev/null) || die "không tải được $p=$v"
      f=$(cd "$CACHE" && ls -1 "${p}_"*"_"*.deb | grep -F "_$(printf '%s' "$v" | sed 's/:/%3a/')_" | head -n1)
      [ -n "$f" ] || die "không thấy .deb của $p=$v"
      echo "$p=$v $(sha256sum "$CACHE/$f" | cut -d' ' -f1) $f"
    done
  } > "$tmp"
  mv "$tmp" "$LOCK"
  echo "release-offline: đã ghi $LOCK ($(grep -cv '^#' "$LOCK") gói)"
  exit 0
fi

[ -f "$REL/manifest.json" ] || { echo "→ chưa có $REL: make release"; VERSION="$VER" ARCH="$ARCH" bash scripts/release.sh; }
for f in manifest.json manifest.sig; do [ -f "$REL/$f" ] || die "thiếu $REL/$f"; done

KEY="${ITSO_RELEASE_KEY:-$ROOT/build/release-key/dev-ed25519.pem}"
[ -f "$KEY" ] || die "không có khóa ký $KEY (make release sinh khóa DEV, hoặc đặt ITSO_RELEASE_KEY)"
PUB=$(mktemp); trap 'rm -f "$PUB"' EXIT
openssl pkey -in "$KEY" -pubout -out "$PUB"
openssl pkeyutl -verify -pubin -inkey "$PUB" -rawin -in "$REL/manifest.json" -sigfile "$REL/manifest.sig" >/dev/null 2>&1 \
  || die "manifest.json của $REL không ký bằng khóa này: bundle offline phải cùng khóa với bản phát hành"

NAME="itso-$VER-offline"
STAGE="$ROOT/build/stage-offline/$NAME"
rm -rf "$ROOT/build/stage-offline"; mkdir -p "$STAGE/debs"
for f in manifest.json manifest.sig itso install.sh sbom.json release.pub.pem; do
  [ -f "$REL/$f" ] && cp -- "$REL/$f" "$STAGE/$f"
done
tarball=$(grep -o '"name": *"[^"]*", *"kind": *"tarball"' "$REL/manifest.json" | sed -E 's/"name": *"([^"]+)".*/\1/' | head -n1)
[ -n "$tarball" ] && [ -f "$REL/$tarball" ] || die "manifest không có tarball hoặc thiếu file"
cp -- "$REL/$tarball" "$STAGE/$tarball"

n=0
while read -r spec sum file; do
  case "$spec" in ''|'#'*) continue ;; esac
  [[ "$spec" =~ ^[a-z0-9][a-z0-9.+-]*=[A-Za-z0-9.+~:-]+$ ]] || die "dòng lock không hợp lệ: $spec"
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || die "sha256 không hợp lệ cho $spec (chạy --update-lock)"
  [[ "$file" =~ ^[A-Za-z0-9][A-Za-z0-9._+~%-]*\.deb$ ]] || die "tên file không hợp lệ cho $spec: $file"
  if [ ! -f "$CACHE/$file" ]; then
    command -v apt-get >/dev/null || die "thiếu $CACHE/$file và không có apt-get để tải"
    mkdir -p "$CACHE"; (cd "$CACHE" && apt-get download -q "$spec" >/dev/null) || die "không tải được $spec"
  fi
  echo "$sum  $CACHE/$file" | sha256sum -c --quiet - >/dev/null 2>&1 || die "sha256 của $file KHÁC lock: dừng (không dùng gói lạ)"
  cp -- "$CACHE/$file" "$STAGE/debs/$file"
  n=$((n + 1))
done < "$LOCK"

if [ "$n" -gt 0 ]; then
  command -v dpkg-scanpackages >/dev/null || die "cần dpkg-scanpackages (gói dpkg-dev) để dựng chỉ mục apt"
  (cd "$STAGE/debs" && dpkg-scanpackages --multiversion . /dev/null 2>/dev/null) > "$STAGE/Packages"
else
  : > "$STAGE/Packages"
  echo "release-offline: CẢNH BÁO lock rỗng — bundle chỉ cài được trên máy đã có sẵn các gói gốc (chạy --update-lock trên Ubuntu 24.04)"
fi

python3 - "$STAGE" "$VER" "$LOCK" <<'PY'
import datetime, hashlib, json, os, sys
stage, ver, lock = sys.argv[1:4]
sha = lambda p: hashlib.sha256(open(os.path.join(stage, p), "rb").read()).hexdigest()
pkgs = []
for line in open(lock):
    if line.strip() and not line.startswith("#"):
        spec, s, f = line.split()
        name, v = spec.split("=", 1)
        pkgs.append({"package": name, "version": v, "file": f})
files = ["manifest.json", "Packages"] + ["debs/" + p["file"] for p in pkgs]
m = {"name": "itso-panel-offline", "version": ver, "created_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
     "target": "ubuntu-24.04", "acme": "disabled", "packages": pkgs, "files": [{"path": p, "sha256": sha(p)} for p in files]}
# Một dòng: install.sh đọc bằng grep (không cần jq).
open(os.path.join(stage, "offline-manifest.json"), "w").write(json.dumps(m, ensure_ascii=False) + "\n")
PY
openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$STAGE/offline-manifest.json" -out "$STAGE/offline-manifest.sig"
openssl pkeyutl -verify -pubin -inkey "$PUB" -rawin -in "$STAGE/offline-manifest.json" -sigfile "$STAGE/offline-manifest.sig" >/dev/null

OUT="$REL/$NAME.tar"
tar -C "$ROOT/build/stage-offline" --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01 00:00Z' -cf "$OUT" "$NAME"
rm -rf "$ROOT/build/stage-offline"
echo "release-offline: $OUT ($n gói .deb, $(du -h "$OUT" | cut -f1))"
