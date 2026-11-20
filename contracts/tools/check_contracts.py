#!/usr/bin/env python3
"""Kiểm tra ngữ nghĩa contracts ITSO Panel (bổ sung cho Redocly lint).

1. Mọi operation có operationId, duy nhất trên cả admin + portal.
2. POST/PUT/PATCH/DELETE trả 202 ⇔ có header Idempotency-Key, và 202 trả JobAccepted.
3. Mọi response 4xx/5xx dùng application/problem+json với schema Problem.
4. Portal không chứa path/tag/schema admin-only; không file nào có /api/provisioning (DEFERRED).
5. Mọi example (request + response) hợp lệ với schema (JSON Schema 2020-12); thống kê độ phủ example.
6. Op trong các bước Job của example đều có trong agent-ops/catalog.json.
7. Mẫu ràng buộc trong common.yaml trùng agent-ops/defs.schema.json; mọi pattern tương thích RE2 (Go).
8. Agent-ops: schema hợp lệ, envelope mẫu hợp lệ/không hợp lệ đúng kỳ vọng.
9. evil-inputs.json: ≥ 60 vector; vector tầng schema cho kết quả đúng kỳ vọng.

Thoát 1 nếu có lỗi. In số liệu để ghi vào TEST_REPORT.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[1]
OA = ROOT / "openapi"
AG = ROOT / "agent-ops"
errors: list[str] = []
stats: dict[str, object] = {}

ADMIN_ONLY_SEGMENTS = {"servers", "hosting-packages", "users", "roles", "api-tokens", "firewall", "docker",
                       "compose-projects", "registries", "software", "settings", "audit-logs", "placement",
                       "account-migrations", "purge-records", "backup-destinations", "backup-policies", "security",
                       "alert-rules", "alerts", "metrics", "uptime-checks", "dashboard", "php-versions", "dns"}
ADMIN_ONLY_TAGS = {"Servers", "Packages", "Users", "Firewall", "Docker", "Software", "Settings", "Audit", "Security",
                   "WAF", "Malware", "Migrations", "Monitoring", "DNS"}
METHODS = ("get", "post", "put", "patch", "delete")


def fail(msg: str):
    errors.append(msg)


def load_yaml(p: Path):
    return yaml.safe_load(p.read_text(encoding="utf-8"))


def esc(seg: str) -> str:
    return seg.replace("~", "~0").replace("/", "~1")


# ---------------------------------------------------------------- nạp OpenAPI
docs = {name: load_yaml(OA / f"{name}.yaml") for name in ("common", "itso-admin-v1", "itso-portal-v1")}
uris = {name: f"file://{OA}/{name}.yaml" for name in docs}
registry = Registry().with_resources(
    [(uris[n], Resource.from_contents(d, default_specification=DRAFT202012)) for n, d in docs.items()])
AG_BASE = "https://schemas.itso.local/agent-ops"
registry = registry.with_resources([(f"{AG_BASE}/{p.relative_to(AG)}", Resource.from_contents(
    json.loads(p.read_text(encoding="utf-8")), default_specification=DRAFT202012)) for p in AG.rglob("*.schema.json")])
registry = registry.crawl()
fmt = FormatChecker()


def resolve(doc_name: str, node: dict):
    """Theo $ref (một cấp hoặc nhiều cấp) để lấy object thật cùng tài liệu chứa nó."""
    seen = 0
    while isinstance(node, dict) and "$ref" in node and seen < 10:
        r = node["$ref"]
        file_part, _, ptr = r.partition("#")
        if file_part:
            doc_name = Path(file_part).stem
        node = docs[doc_name]
        for seg in [x for x in ptr.split("/") if x]:
            node = node[seg.replace("~1", "/").replace("~0", "~")]
        seen += 1
    return doc_name, node


def validate_example(doc_name: str, pointer: str, example, where: str):
    v = Draft202012Validator({"$ref": f"{uris[doc_name]}#{pointer}"}, registry=registry, format_checker=fmt)
    errs = sorted(v.iter_errors(example), key=lambda e: list(e.path))
    if errs:
        e = errs[0]
        fail(f"Example sai schema [{where}] tại {'/'.join(map(str, e.path)) or '(gốc)'}: {e.message[:200]}")
        return False
    return True


# ---------------------------------------------------------------- 1–6: operation
op_ids: dict[str, str] = {}
ops_total = ops_with_example = ops_no_body = 0
examples_checked = 0
step_ops: set[str] = set()
job_ops = 0


def collect_steps(x):
    if isinstance(x, dict):
        if "steps" in x and isinstance(x["steps"], list):
            for st in x["steps"]:
                if isinstance(st, dict) and "op" in st:
                    step_ops.add(st["op"])
        for v in x.values():
            collect_steps(v)
    elif isinstance(x, list):
        for v in x:
            collect_steps(v)


for name in ("itso-admin-v1", "itso-portal-v1"):
    doc = docs[name]
    realm = "admin" if "admin" in name else "portal"
    for path, item in doc["paths"].items():
        if "/api/provisioning" in path:
            fail(f"{name}: path DEFERRED {path}")
        if realm == "portal":
            if path.startswith("/api/v1/admin"):
                fail(f"portal chứa path admin: {path}")
            if not re.match(r"^/api/v1/(portal|auth|system)(/|$)", path):
                fail(f"portal có path ngoài prefix cho phép: {path}")
            segs = set(re.split(r"[/:]", path))
            bad = segs & ADMIN_ONLY_SEGMENTS
            if bad:
                fail(f"portal chứa tài nguyên admin-only {sorted(bad)}: {path}")
        else:
            if not re.match(r"^/api/v1/(admin|auth|system)(/|$)", path):
                fail(f"admin có path ngoài prefix cho phép: {path}")
        for method in METHODS:
            if method not in item:
                continue
            op = item[method]
            ops_total += 1
            base_ptr = f"/paths/{esc(path)}/{method}"
            oid = op.get("operationId")
            where = f"{name} {method.upper()} {path}"
            if not oid:
                fail(f"Thiếu operationId: {where}")
            elif oid in op_ids:
                # Endpoint chung (/auth, /system) có mặt ở cả hai file với cùng operationId là hợp lệ.
                prev = op_ids[oid]
                shared_ep = re.match(r"^/api/v1/(auth|system)/", path) and prev.split(" ", 1)[1] == f"{method.upper()} {path}"
                if not shared_ep:
                    fail(f"operationId trùng {oid}: {where} và {prev}")
            else:
                op_ids[oid] = where
            if realm == "portal" and set(op.get("tags", [])) & ADMIN_ONLY_TAGS:
                fail(f"portal dùng tag admin-only {op['tags']}: {where}")
            params = [resolve(name, p)[1] for p in op.get("parameters", [])]
            has_idem = any(p.get("name") == "Idempotency-Key" and p.get("in") == "header" for p in params)
            if any(p.get("name") == "Idempotency-Key" and not p.get("required") for p in params):
                fail(f"Idempotency-Key phải required: {where}")
            responses = op.get("responses", {})
            is_job = "202" in responses
            if is_job:
                job_ops += 1
                if method == "get":
                    fail(f"GET không được trả 202 Job: {where}")
                if not has_idem:
                    fail(f"Operation tạo job thiếu Idempotency-Key: {where}")
                sch = responses["202"].get("content", {}).get("application/json", {}).get("schema", {})
                if not sch.get("$ref", "").endswith("/components/schemas/JobAccepted"):
                    fail(f"202 phải trả JobAccepted: {where}")
            elif has_idem:
                fail(f"Có Idempotency-Key nhưng không trả 202 Job: {where}")
            if method == "post" and re.search(r":[a-z-]+$", path) and not is_job and "auth" not in path:
                # Hành động trên tài nguyên không tạo job phải được liệt kê rõ (đọc/đổi trạng thái panel thuần).
                stats.setdefault("sync_actions", []).append(f"{method.upper()} {path}")
            for code, resp in responses.items():
                rname, robj = resolve(name, resp)
                if code.startswith(("4", "5")):
                    content = robj.get("content", {})
                    pj = content.get("application/problem+json")
                    if not pj or list(content) != ["application/problem+json"]:
                        fail(f"Response {code} phải chỉ dùng application/problem+json: {where}")
                    elif not pj.get("schema", {}).get("$ref", "").endswith("/components/schemas/Problem"):
                        fail(f"Response {code} phải dùng schema Problem: {where}")
            # examples
            has_media = False
            has_ex = False
            rb = op.get("requestBody", {}).get("content", {})
            for mt, media in rb.items():
                has_media = True
                if "example" in media:
                    has_ex = True
                    if "json" in mt:
                        examples_checked += 1
                        validate_example(name, f"{base_ptr}/requestBody/content/{esc(mt)}/schema", media["example"],
                                         f"{where} request")
            for code, resp in responses.items():
                if not code.startswith("2") or "$ref" in resp:
                    continue
                for mt, media in resp.get("content", {}).items():
                    has_media = True
                    if "example" in media:
                        has_ex = True
                        collect_steps(media["example"])
                        if "json" in mt:
                            examples_checked += 1
                            validate_example(name, f"{base_ptr}/responses/{code}/content/{esc(mt)}/schema",
                                             media["example"], f"{where} {code}")
            if not has_media:
                ops_no_body += 1
            elif has_ex:
                ops_with_example += 1
            else:
                fail(f"Operation có body nhưng thiếu example: {where}")

# response dùng chung trong common.yaml cũng phải có example hợp lệ
for rn, resp in docs["common"]["components"]["responses"].items():
    for mt, media in resp["content"].items():
        examples_checked += 1
        validate_example("common", f"/components/responses/{rn}/content/{esc(mt)}/schema", media.get("example"),
                         f"common response {rn}")

for name in docs:
    text = (OA / f"{name}.yaml").read_text(encoding="utf-8")
    if "/api/provisioning" in text:
        fail(f"{name}.yaml nhắc tới /api/provisioning (DEFERRED)")
if "itso-admin-v1.yaml" in (OA / "itso-portal-v1.yaml").read_text(encoding="utf-8"):
    fail("portal tham chiếu schema của file admin")

# ---------------------------------------------------------------- 6: op trong job ↔ catalog
catalog = json.loads((AG / "catalog.json").read_text(encoding="utf-8"))
known = {o["op"] for o in catalog["ops"]} | set(catalog["panel_steps"])
missing = sorted(step_ops - known)
if missing:
    fail(f"Op trong Job example không có trong catalog agent: {missing}")

# ---------------------------------------------------------------- 7: pattern đồng bộ + RE2
defs = json.loads((AG / "defs.schema.json").read_text(encoding="utf-8"))["$defs"]
common_schemas = docs["common"]["components"]["schemas"]
shared = ["Domain", "Username", "RelPath", "DbName", "CronExpr", "CronCommand", "NginxSize", "HeaderValue", "PhpVersion", "Cidr"]
for k in shared:
    if common_schemas.get(k) != defs.get(k):
        fail(f"Mẫu {k} khác nhau giữa common.yaml và defs.schema.json")
RE2_BAD = re.compile(r"\(\?[=!<]|\\[1-9]")
patterns: list[str] = []


def walk_patterns(x):
    if isinstance(x, dict):
        for k, v in x.items():
            if k == "pattern" and isinstance(v, str):
                patterns.append(v)
            else:
                walk_patterns(v)
    elif isinstance(x, list):
        for v in x:
            walk_patterns(v)


for d in docs.values():
    walk_patterns(d)
for p in AG.rglob("*.schema.json"):
    walk_patterns(json.loads(p.read_text(encoding="utf-8")))
for pat in set(patterns):
    if RE2_BAD.search(pat):
        fail(f"Pattern không tương thích RE2 (Go): {pat}")
    try:
        re.compile(pat)
    except re.error as e:
        fail(f"Pattern lỗi: {pat}: {e}")

# ---------------------------------------------------------------- 8: agent-ops
schema_files = sorted(AG.rglob("*.schema.json"))
for p in schema_files:
    try:
        Draft202012Validator.check_schema(json.loads(p.read_text(encoding="utf-8")))
    except Exception as e:  # noqa: BLE001
        fail(f"Schema agent không hợp lệ {p.name}: {e}")
spec_ops = [o for o in catalog["ops"] if o["status"] == "specified"]
for o in spec_ops:
    if not (AG / o["schema"]).exists():
        fail(f"Thiếu schema cho op {o['op']}")
env_v = Draft202012Validator({"$ref": f"{AG_BASE}/envelope.schema.json"}, registry=registry, format_checker=fmt)
ex = json.loads((AG / "examples" / "envelopes.json").read_text(encoding="utf-8"))
for k, e in enumerate(ex["valid"]):
    errs = list(env_v.iter_errors(e))
    if errs:
        fail(f"Envelope mẫu hợp lệ #{k + 1} ({e['op']}) bị từ chối: {errs[0].message[:200]}")
for e in ex["invalid"]:
    if not list(env_v.iter_errors(e["envelope"])):
        fail(f"Envelope mẫu KHÔNG hợp lệ lại được chấp nhận: {e['why']}")
res_v = Draft202012Validator({"$ref": f"{AG_BASE}/result.schema.json"}, registry=registry)
for sample, expect in [({"v": 1, "op_id": "x:1:1", "ok": True, "data": {"created": True}, "duration_ms": 12,
                         "agent_version": "0.1.0"}, True),
                       ({"v": 1, "op_id": "x:1:1", "ok": False, "duration_ms": 3, "agent_version": "0.1.0"}, False),
                       ({"v": 1, "op_id": "x:1:1", "ok": False, "error": {"code": "path_outside_home", "message": "x",
                                                                        "retryable": False}, "duration_ms": 3,
                         "agent_version": "0.1.0"}, True)]:
    if (not list(res_v.iter_errors(sample))) != expect:
        fail(f"Result schema cho kết quả sai với mẫu {sample}")

# ---------------------------------------------------------------- 9: evil inputs
vec = json.loads((ROOT / "test-vectors" / "evil-inputs.json").read_text(encoding="utf-8"))
total = schema_layer = semantic = 0
for cat, c in vec["categories"].items():
    v = Draft202012Validator({"$ref": c["schema"].replace("agent-ops", AG_BASE, 1)}, registry=registry, format_checker=fmt)
    for x in c["vectors"]:
        total += 1
        if x["layer"] == "semantic":
            semantic += 1
            continue
        schema_layer += 1
        ok = not list(v.iter_errors(x["input"]))
        if ok != (x["expect"] == "accept"):
            fail(f"Vector {cat} {x['input']!r}: mong {x['expect']}, schema {'chấp nhận' if ok else 'từ chối'}")
if total < 60:
    fail(f"evil-inputs chỉ có {total} vector (< 60)")

# ---------------------------------------------------------------- tổng kết
admin_ops = sum(1 for p in docs["itso-admin-v1"]["paths"].values() for m in p if m in METHODS)
portal_ops = ops_total - admin_ops
cov = ops_with_example / max(1, ops_total - ops_no_body) * 100
print(f"OpenAPI: {ops_total} operation (admin {admin_ops}, portal {portal_ops}); job 202: {job_ops}")
print(f"Example: {examples_checked} example đã validate; độ phủ {ops_with_example}/{ops_total - ops_no_body} "
      f"operation có body = {cov:.1f}% ({ops_no_body} operation không có body: 204/không nội dung)")
print(f"Agent-ops: {len(schema_files)} schema hợp lệ; {len(spec_ops)} op có schema; envelope mẫu "
      f"{len(ex['valid'])} hợp lệ + {len(ex['invalid'])} bị từ chối đúng")
print(f"Op trong Job example: {len(step_ops)}, đều có trong catalog" if not missing else "")
print(f"Evil inputs: {total} vector ({schema_layer} tầng schema đã kiểm, {semantic} tầng nghiệp vụ cho Phase 3–6)")
print(f"Pattern kiểm RE2: {len(set(patterns))}")
if cov < 95:
    fail(f"Độ phủ example {cov:.1f}% < 95%")
if errors:
    print(f"\n✗ {len(errors)} lỗi:")
    for e in errors[:60]:
        print("  -", e)
    sys.exit(1)
print("✓ check_contracts: không có lỗi")
