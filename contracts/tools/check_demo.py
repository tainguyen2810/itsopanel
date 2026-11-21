#!/usr/bin/env python3
"""Kiểm dữ liệu demo (contracts/examples/demo-dataset.json) nhất quán.

- Tham chiếu (account → server/gói/chủ, website → account, …) phải trỏ tới bản ghi có thật, đúng tên.
- Số tổng hợp (dashboard, account_count, usage.*.used, domains_count) phải bằng số đếm từ dữ liệu chi tiết.
- Khóa duy nhất: username account, UID trên cùng server, domain, tên database.
Exit 1 kèm danh sách lỗi nếu có. Chạy: python3 contracts/tools/check_demo.py
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
D = json.loads((ROOT / "examples" / "demo-dataset.json").read_text(encoding="utf-8"))
errors: list[str] = []


def index(name: str, key: str = "uuid") -> dict:
    return {x[key]: x for x in D[name]}


# UUID trùng trong một bảng làm React báo trùng key và handler sửa nhầm bản ghi.
for _name, _rows in D.items():
    if isinstance(_rows, list):
        _seen: set[str] = set()
        for _x in _rows:
            _id = _x.get("uuid") if isinstance(_x, dict) else None
            if _id is not None and _id in _seen:
                errors.append(f"{_name}: uuid {_id} bị trùng")
            if _id is not None:
                _seen.add(_id)


users, servers, packages = index("users"), index("servers"), index("packages")
accounts, websites, databases = index("accounts"), index("websites"), index("databases")


def check_ref(where: str, ref: dict | None, table: dict, field: str | None = None, value_key: str | None = None):
    if ref is None:
        return
    target = table.get(ref["uuid"])
    if target is None:
        errors.append(f"{where}: tham chiếu {ref['uuid']} không tồn tại")
    elif field and ref.get(field) != target.get(value_key or field):
        errors.append(f"{where}: {field}={ref.get(field)!r} khác bản gốc {target.get(value_key or field)!r}")


for a in D["accounts"]:
    w = f"account {a['username']}"
    check_ref(w, a["server"], servers, "name")
    check_ref(w, a["owner"], users, "email")
    check_ref(w, a["package"], packages, "code")
    if users.get(a["owner"]["uuid"], {}).get("realm") != "portal":
        errors.append(f"{w}: chủ account phải là user realm portal")
for name, table in (("websites", websites), ("databases", databases), ("sftp", None), ("cron", None),
                    ("db_users", None), ("snapshots", None), ("wordpress", None)):
    for x in D[name]:
        check_ref(f"{name} {x.get('uuid')}", x.get("hosting_account"), accounts, "username")
        if "server" in x and x.get("hosting_account"):
            acc = accounts.get(x["hosting_account"]["uuid"])
            if acc and x["server"]["uuid"] != acc["server"]["uuid"]:
                errors.append(f"{name} {x['uuid']}: server khác server của account")
for name in ("domains", "certs", "wordpress"):
    for x in D[name]:
        check_ref(f"{name} {x['uuid']}", x["website"], websites, "primary_domain")
for j in D["jobs"]:
    check_ref(f"job {j['uuid']}", j["server"], servers, "name")
    check_ref(f"job {j['uuid']}", j["requested_by"], users, "email")
    tables = {"hosting_account": accounts, "website": websites, "database": databases, "server": servers}
    if j["resource"]["type"] in tables and j["resource"]["uuid"] not in tables[j["resource"]["type"]]:
        errors.append(f"job {j['uuid']}: resource không tồn tại")
for e in D["audit"]:
    check_ref(f"audit {e['uuid']}", e["actor"], users, "email")

# Số tổng hợp.
live = [a for a in D["accounts"] if a["lifecycle_state"] != "terminated"]


def cnt(name, key, uuid):
    return sum(1 for x in D[name] if (x.get(key) or {}).get("uuid") == uuid)


for a in D["accounts"]:
    for field, name in (("websites", "websites"), ("databases", "databases"), ("ftp_accounts", "sftp"),
                        ("cron_jobs", "cron")):
        got, want = a["usage"][field]["used"], cnt(name, "hosting_account", a["uuid"])
        if got != want:
            errors.append(f"account {a['username']}: usage.{field}.used={got}, thực tế {want}")
for s in D["servers"]:
    want = sum(1 for a in live if a["server"]["uuid"] == s["uuid"])
    if s["account_count"] != want:
        errors.append(f"server {s['name']}: account_count={s['account_count']}, thực tế {want}")
for p in D["packages"]:
    want = sum(1 for a in live if a["package"]["uuid"] == p["uuid"])
    if p["account_count"] != want:
        errors.append(f"gói {p['code']}: account_count={p['account_count']}, thực tế {want}")
for w in D["websites"]:
    want = cnt("domains", "website", w["uuid"])
    if w["domains_count"] != want:
        errors.append(f"website {w['primary_domain']}: domains_count={w['domains_count']}, thực tế {want}")
want_counts = {"servers": len(D["servers"]), "hosting_accounts": len(live), "websites": len(D["websites"]),
               "databases": len(D["databases"]), "users": len(D["users"]), "packages": len(D["packages"])}
if D["dashboard"]["counts"] != want_counts:
    errors.append(f"dashboard.counts={D['dashboard']['counts']}, thực tế {want_counts}")
if D["dashboard"]["jobs_running"] != sum(1 for j in D["jobs"] if j["state"] == "running"):
    errors.append("dashboard.jobs_running lệch danh sách job")

# Khóa duy nhất.
for label, values in (("username account", [a["username"] for a in D["accounts"]]),
                      ("domain", [d["name"] for d in D["domains"]]),
                      ("tên database", [d["name"] for d in D["databases"]]),
                      ("email user", [u["email"] for u in D["users"]]),
                      ("UID trên server", [(a["server"]["uuid"], a["uid"]) for a in D["accounts"]])):
    dup = [v for v, n in Counter(values).items() if n > 1]
    if dup:
        errors.append(f"trùng {label}: {dup}")

if errors:
    print("check_demo: LỖI\n  " + "\n  ".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"check_demo: OK — {len(D['accounts'])} account, {len(D['websites'])} website, {len(D['databases'])} database, "
      f"{len(D['jobs'])} job; tham chiếu và số tổng hợp khớp")
