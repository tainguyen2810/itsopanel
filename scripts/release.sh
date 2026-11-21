#!/usr/bin/env bash
# make release: đóng gói bản phát hành ITSO Panel (10 §10) vào build/release/<ver>/:
#   itso-<ver>-linux-<arch>.tar.gz  (bin/, api/ --no-dev, web/, packaging/, checksums.txt)
#   itso (CLI, cạnh tarball để install.sh tải), install.sh (khóa công khai nhúng), sbom.json,
#   manifest.json + manifest.sig (Ed25519, openssl).
# Khóa ký: ITSO_RELEASE_KEY (PEM Ed25519). Không đặt → sinh KHÓA DEV TẠM ở build/release-key/ (không commit).
# Thiếu frankenphp (cần tải từ upstream): ghi "missing" trong manifest, chưa phát hành thật được.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
VER="${VERSION:-0.4.0-dev}"
ARCH="${ARCH:-amd64}"
PNPM="${PNPM:-corepack pnpm}"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "VERSION không hợp lệ: $VER" >&2; exit 1; }

OUT="$ROOT/build/release/$VER"
STAGE="$ROOT/build/stage/itso-$VER"
rm -rf "$OUT" "$STAGE"
mkdir -p "$OUT" "$STAGE"/{bin,packaging}

KEY="${ITSO_RELEASE_KEY:-}"
if [ -z "$KEY" ]; then
  KEY="$ROOT/build/release-key/dev-ed25519.pem"
  if [ ! -f "$KEY" ]; then
    mkdir -p "$(dirname "$KEY")"
    (umask 077; openssl genpkey -algorithm ed25519 -out "$KEY")
    echo "release: đã sinh khóa DEV tạm $KEY (chỉ để thử, không dùng phát hành thật)"
  fi
fi
openssl pkey -in "$KEY" -pubout -out "$OUT/release.pub.pem"
PUB_B64=$(openssl pkey -in "$KEY" -pubout -outform DER | tail -c 32 | base64 -w0)

echo "→ web"
(cd apps/web && $PNPM -s build >/dev/null)
cp -r apps/web/dist "$STAGE/web"

echo "→ api (composer --no-dev)"
mkdir -p "$STAGE/api"
tar -C apps/api --exclude=./vendor --exclude=./tests --exclude=./node_modules --exclude='./.env' --exclude='./.env.*' \
  --exclude='./storage/logs/*' --exclude='./storage/framework/*/*' --exclude='./bootstrap/cache/*.php' --exclude='./.phpunit*' -cf - . \
  | tar -C "$STAGE/api" -xf -
cp apps/api/.env.example "$STAGE/api/.env.example"
(cd "$STAGE/api" && COMPOSER_NO_DEV=1 composer install --no-dev --prefer-dist --optimize-autoloader --classmap-authoritative --no-interaction --no-progress --quiet)

echo "→ Go (CGO_ENABLED=0, -trimpath)"
LDF="-s -w -X main.version=$VER -X main.releasePubKey=$PUB_B64"
(cd agent && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -ldflags "$LDF" -o "$STAGE/bin/itso" ./cmd/itso)
(cd agent && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -ldflags "-s -w -X itso.local/agent/internal/ops.Version=$VER" -o "$STAGE/bin/itso-agent" ./cmd/itso-agent)
(cd agent && CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath -ldflags "-s -w -X itso.local/agent/internal/ops.Version=$VER" -o "$STAGE/bin/itso-gateway" ./cmd/itso-gateway)

cp -r packaging/systemd "$STAGE/packaging/systemd"
cp packaging/Caddyfile "$STAGE/packaging/Caddyfile"
mkdir -p "$STAGE/share" && cp -r packaging/share/yara "$STAGE/share/yara"
echo "$VER" > "$STAGE/VERSION"
MISSING=()
[ -x "$STAGE/bin/frankenphp" ] || MISSING+=("frankenphp")
(cd "$STAGE" && find . -name .git -prune -o -type f ! -name checksums.txt -print0 | sort -z | xargs -0 sha256sum > checksums.txt)

TARBALL="itso-$VER-linux-$ARCH.tar.gz"
tar -C "$ROOT/build/stage" --exclude-vcs --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01 00:00Z' -czf "$OUT/$TARBALL" "itso-$VER"
cp "$STAGE/bin/itso" "$OUT/itso"

python3 - "$OUT/release.pub.pem" "$VER" > "$OUT/install.sh" <<'PY'
import sys
pem = open(sys.argv[1]).read().strip()
s = open("packaging/install.sh.in").read()
s = s.replace("@PUBKEY_PEM@", pem).replace("@VERSION@", sys.argv[2]).replace("@RELEASE_URL@", "https://install.itso.invalid/releases")
sys.stdout.write(s)
PY
chmod 0755 "$OUT/install.sh"

echo "→ SBOM"
python3 scripts/sbom.py "$VER" > "$OUT/sbom.json"

python3 - "$OUT" "$VER" "$TARBALL" "${MISSING[*]:-}" <<'PY'
import hashlib, json, os, sys, datetime
out, ver, tarball, missing = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
def art(name, kind):
    p = os.path.join(out, name)
    return {"name": name, "kind": kind, "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest(), "size": os.path.getsize(p)}
m = {"name": "itso-panel", "version": ver, "created_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
     "min_from_version": "0.0.0", "breaking_db": False,
     "artifacts": [art(tarball, "tarball"), art("itso", "binary"), art("sbom.json", "sbom"), art("install.sh", "installer")],
     "missing_components": [x for x in missing.split() if x]}
# Một dòng: install.sh đọc artifact bằng grep (không cần jq).
open(os.path.join(out, "manifest.json"), "w").write(json.dumps(m, ensure_ascii=False) + "\n")
PY
openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$OUT/manifest.json" -out "$OUT/manifest.sig"
openssl pkeyutl -verify -pubin -inkey "$OUT/release.pub.pem" -rawin -in "$OUT/manifest.json" -sigfile "$OUT/manifest.sig" >/dev/null
rm -rf "$ROOT/build/stage"
echo "release: $OUT"
ls -l "$OUT"
[ ${#MISSING[@]} -eq 0 ] || echo "release: CẢNH BÁO thiếu thành phần: ${MISSING[*]} (bản dev, chưa cài thật được)"
