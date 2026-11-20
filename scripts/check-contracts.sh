#!/usr/bin/env bash
# Kiểm tra toàn bộ contracts: sinh lại không tạo diff, Redocly lint, kiểm ngữ nghĩa, ajv cho agent-ops.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
C="$ROOT/contracts"
PNPX="${PNPX:-npx -y}"
export REDOCLY_TELEMETRY=off NO_UPDATE_NOTIFIER=1

echo "→ 1/5 Sinh lại contracts và so sánh (không được có diff)"
before=$(cd "$C" && find openapi agent-ops test-vectors examples -type f | LC_ALL=C sort | xargs sha256sum)
python3 "$C/tools/gen_openapi.py" >/dev/null
python3 "$C/tools/gen_agent_ops.py" >/dev/null
python3 "$C/tools/gen_vectors.py" >/dev/null
after=$(cd "$C" && find openapi agent-ops test-vectors examples -type f | LC_ALL=C sort | xargs sha256sum)
if [[ "$before" != "$after" ]]; then
  echo "✗ File sinh ra khác bản đã có. Chạy 'make contracts' rồi commit:"
  diff <(echo "$before") <(echo "$after") || true
  exit 1
fi
echo "  ✓ không có diff"

echo "→ 2/5 Redocly lint (ruleset contracts/redocly.yaml)"
(cd "$C" && $PNPX @redocly/cli@2.71.0 lint --config redocly.yaml --format=summary 2>&1 | grep -E "validated|valid|error|warning" | grep -v "new version")

echo "→ 3/5 Kiểm ngữ nghĩa (tools/check_contracts.py)"
python3 "$C/tools/check_contracts.py"

echo "→ 4/5 ajv: compile schema agent-ops (strict) và envelope mẫu hợp lệ"
cd "$C/agent-ops"
AJV=($PNPX -p ajv-cli@5.0.0 -p ajv-formats@3.0.1 ajv)
REFS=(-r defs.schema.json -r errors.schema.json -r "ops/*.schema.json")
"${AJV[@]}" compile --spec=draft2020 -c ajv-formats --strict=true -s envelope.schema.json -s result.schema.json "${REFS[@]}" 2>&1 | grep -v "npm warn"
"${AJV[@]}" validate --spec=draft2020 -c ajv-formats --strict=true -s envelope.schema.json "${REFS[@]}" -d "examples/valid-*.json" 2>&1 | grep -v "npm warn"

echo "→ 5/5 ajv: envelope mẫu KHÔNG hợp lệ phải bị từ chối"
n=0
for f in examples/invalid-*.json; do
  if "${AJV[@]}" validate --spec=draft2020 -c ajv-formats --strict=true -s envelope.schema.json "${REFS[@]}" -d "$f" >/dev/null 2>&1; then
    echo "✗ $f lại hợp lệ"; exit 1
  fi
  n=$((n + 1))
done
echo "  ✓ $n envelope không hợp lệ đều bị từ chối"
echo "✓ contracts-check: PASS"
