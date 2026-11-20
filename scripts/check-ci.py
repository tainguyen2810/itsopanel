#!/usr/bin/env python3
"""Kiểm .github/workflows/ci.yml khi không có actionlint: YAML hợp lệ, cấu trúc job đúng,
mọi `make <target>` được gọi đều có trong Makefile, action được ghim phiên bản."""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
wf = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
targets = set(re.findall(r"^([A-Za-z0-9_-]+):", (ROOT / "Makefile").read_text(), re.M))
errors: list[str] = []

# PyYAML đọc khóa `on` thành True.
if not (wf.get("on") or wf.get(True)):
    errors.append("thiếu trigger `on`")
if wf.get("permissions", {}).get("contents") != "read":
    errors.append("permissions.contents phải là read")
jobs = wf.get("jobs") or {}
need = {"structure", "docs", "database", "contracts", "web", "api", "agent"}
if missing := need - set(jobs):
    errors.append(f"thiếu job: {sorted(missing)}")

calls = 0
for name, job in jobs.items():
    if "runs-on" not in job:
        errors.append(f"{name}: thiếu runs-on")
    for i, step in enumerate(job.get("steps") or []):
        if "uses" in step and not re.search(r"@v?\d", step["uses"]):
            errors.append(f"{name}#{i}: action chưa ghim phiên bản: {step['uses']}")
        if "uses" not in step and "run" not in step:
            errors.append(f"{name}#{i}: step không có uses/run")
        for t in re.findall(r"\bmake ([A-Za-z0-9_-]+)", step.get("run", "")):
            calls += 1
            if t not in targets:
                errors.append(f"{name}#{i}: `make {t}` không có trong Makefile")

if errors:
    print("check-ci: LỖI\n  " + "\n  ".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"check-ci: OK — {len(jobs)} job, {calls} lệnh make đều có trong Makefile")
