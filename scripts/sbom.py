#!/usr/bin/env python3
"""SBOM tối giản (danh sách dependency đã đóng gói): composer (không dev), npm (không dev), Go module."""
import json, subprocess, sys

ver = sys.argv[1] if len(sys.argv) > 1 else "dev"
comps = []
lock = json.load(open("apps/api/composer.lock"))
for p in lock.get("packages", []):
    comps.append({"type": "composer", "name": p["name"], "version": p["version"], "license": p.get("license", [])})
web = json.load(open("apps/web/package.json"))
for name, v in sorted(web.get("dependencies", {}).items()):  # dependency trực tiếp (bản build gói chúng)
    comps.append({"type": "npm", "name": name, "version": v})
mods = subprocess.run(["go", "list", "-m", "all"], cwd="agent", capture_output=True, text=True, check=True).stdout.split("\n")
for line in mods[1:]:
    f = line.split()
    if len(f) >= 2:
        comps.append({"type": "go", "name": f[0], "version": f[1]})
json.dump({"format": "itso-sbom/1", "product": "itso-panel", "version": ver, "components": comps}, sys.stdout, ensure_ascii=False, indent=1)
sys.stdout.write("\n")
