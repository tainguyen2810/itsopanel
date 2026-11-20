#!/usr/bin/env bash
# Kiểm tra cấu trúc repository ITSO Panel (Prompt 1.1).
# Exit 0 khi đủ thư mục và file bắt buộc; exit 1 và liệt kê mục thiếu nếu không.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

required_dirs=(
  apps/web apps/api agent
  contracts/openapi contracts/agent-ops contracts/test-vectors
  database/schema database/docs
  design/tokens design/docs
  installer packaging demo scripts
  docs/planning docs/planning/seed docs/adr docs/runbooks docs/screenshots
  docs/ui docs/gate docs/reports
)

required_files=(
  README.md CLAUDE.md LICENSE Makefile
  .editorconfig .gitattributes .gitignore
  PROJECT_PLAN.md ARCHITECTURE.md ROADMAP.md DECISIONS.md
  PHASE_STATUS.md TEST_REPORT.md DATABASE.md API.md
  docs/planning/README.md docs/planning/seed/PHASE_1_PROMPTS.md
  scripts/dev.ps1
)

missing=0

for d in "${required_dirs[@]}"; do
  if [[ ! -d "$d" ]]; then
    echo "THIẾU thư mục: $d"; missing=$((missing + 1))
  elif [[ "$d" != docs/planning* && "$d" != scripts && ! -f "$d/README.md" ]]; then
    echo "THIẾU README: $d/README.md"; missing=$((missing + 1))
  fi
done

for f in "${required_files[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "THIẾU file: $f"; missing=$((missing + 1))
  fi
done

# Không được có file secret bị theo dõi bởi git
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example$' >/dev/null; then
    echo "LỖI: có file .env đang được git theo dõi"; missing=$((missing + 1))
  fi
fi

total=$(( ${#required_dirs[@]} + ${#required_files[@]} ))
if [[ $missing -eq 0 ]]; then
  echo "OK: cấu trúc repository hợp lệ (${#required_dirs[@]} thư mục, ${#required_files[@]} file bắt buộc)."
  exit 0
else
  echo "THẤT BẠI: thiếu $missing / $total mục."
  exit 1
fi
