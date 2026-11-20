#!/usr/bin/env bash
# Kiểm tra cú pháp mọi khối ```mermaid trong tài liệu (ngoài docs/planning) bằng mermaid-cli.
# Mỗi khối được render thử ra SVG tạm; lỗi cú pháp → exit 1.
# Biến môi trường: CHROME_PATH (mặc định /opt/pw-browsers/chromium nếu có).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CHROME="${CHROME_PATH:-}"
if [[ -z "$CHROME" && -x /opt/pw-browsers/chromium ]]; then CHROME=/opt/pw-browsers/chromium; fi
PCONF="$TMP/puppeteer.json"
if [[ -n "$CHROME" ]]; then
  printf '{"executablePath":"%s","args":["--no-sandbox","--headless=new"]}\n' "$CHROME" > "$PCONF"
else
  printf '{"args":["--no-sandbox"]}\n' > "$PCONF"
fi

# Tách các khối mermaid thành file riêng
python3 - "$TMP" <<'PY'
import sys, re, pathlib
out = pathlib.Path(sys.argv[1])
n = 0
for p in sorted(pathlib.Path('.').rglob('*.md')):
    s = str(p)
    if s.startswith(('docs/planning', 'node_modules', '.git')) or '/node_modules/' in s:
        continue
    for i, m in enumerate(re.finditer(r"```mermaid\n(.*?)```", p.read_text(encoding='utf-8'), re.S)):
        n += 1
        (out / f"{n:03d}.mmd").write_text(m.group(1), encoding='utf-8')
        (out / f"{n:03d}.src").write_text(f"{s} (khối {i+1})", encoding='utf-8')
print(n)
PY

count=$(ls "$TMP"/*.mmd 2>/dev/null | wc -l)
if [[ "$count" -eq 0 ]]; then echo "Không có khối mermaid nào."; exit 0; fi

fail=0
for f in "$TMP"/*.mmd; do
  src="$(cat "${f%.mmd}.src")"
  if npx -y @mermaid-js/mermaid-cli@11.4.2 -q -p "$PCONF" -i "$f" -o "${f%.mmd}.svg" >"${f%.mmd}.log" 2>&1; then
    echo "OK   $src"
  else
    echo "LỖI  $src"; sed -n '1,5p' "${f%.mmd}.log"; fail=$((fail + 1))
  fi
done

if [[ $fail -gt 0 ]]; then echo "THẤT BẠI: $fail/$count khối mermaid lỗi."; exit 1; fi
echo "OK: $count khối mermaid hợp lệ."
