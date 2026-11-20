#!/usr/bin/env python3
"""Sinh Go structs từ JSON Schema agent-ops → agent/internal/contracts/types_gen.go.

Nguồn: contracts/agent-ops/{defs,envelope,result,errors}.schema.json, catalog.json và ops/*.schema.json.
Mỗi op có `<Op>Params` và `<Op>Result` (vd. `system.ping` → SystemPingParams, SystemPingResult).

Quy tắc ánh xạ (chỉ phục vụ type; ràng buộc pattern/enum/min/max vẫn do validator JSON Schema
trong agent kiểm, struct KHÔNG thay thế validate):
  string → string · integer → int64 · number → float64 · boolean → bool · const true/false → bool
  array → []T · object có properties → struct · object chỉ có additionalProperties → map[string]T
  ["T","null"] → *T · oneOf/anyOf → json.RawMessage · trường không required → con trỏ (trừ slice/map) + omitempty
  $ref tới defs.schema.json → kiểu có tên (vd. Uid, Account)

Chạy:  python3 contracts/tools/gen_go_types.py           (ghi file, cần `gofmt` trong PATH)
       python3 contracts/tools/gen_go_types.py --check   (báo lỗi nếu file đang có lệch)
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "contracts" / "agent-ops"
OUT = ROOT / "agent" / "internal" / "contracts" / "types_gen.go"

INITIALISMS = {
    "id", "uuid", "uid", "gid", "url", "uri", "ip", "ips", "api", "http", "https", "tls", "ssl", "ssh", "sftp",
    "ftp", "dns", "db", "sql", "php", "cpu", "ram", "mb", "gb", "kb", "os", "ttl", "json", "sha256", "html",
    "cidr", "waf", "fpm", "pg", "acme", "hsts", "utc", "pid", "io",
}
SPECIAL = {"ips": "IPs", "mb": "MB", "gb": "GB", "kb": "KB", "ok": "OK"}


def camel(name: str) -> str:
    # Tách theo ký tự phân cách và theo chữ hoa (DbName → Db, Name) rồi viết hoa initialism (DB, UUID…).
    parts = [w for p in re.split(r"[^A-Za-z0-9]+", name) if p for w in re.findall(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])", p)]
    out = []
    for p in parts:
        low = p.lower()
        if low in SPECIAL:
            out.append(SPECIAL[low])
        elif low in INITIALISMS:
            out.append(low.upper())
        else:
            out.append(p[0].upper() + p[1:])
    s = "".join(out)
    return s if s and not s[0].isdigit() else "X" + s


class Gen:
    def __init__(self) -> None:
        self.decls: list[str] = []  # khai báo kiểu theo thứ tự sinh
        self.names: set[str] = set()
        self.uses_raw = False

    # ---------- ánh xạ kiểu ----------
    def ref_name(self, ref: str) -> str:
        m = re.search(r"(?:^|/)(defs|errors)\.schema\.json#/\$defs/(\w+)$", ref)
        if not m:
            raise SystemExit(f"gen_go_types: $ref chưa hỗ trợ: {ref}")
        return m.group(2)

    def gotype(self, s: dict, hint: str) -> str:
        """Trả về biểu thức kiểu Go cho schema s; sinh struct con với tên hint nếu cần."""
        if "$ref" in s:
            return camel(self.ref_name(s["$ref"]))
        if ("oneOf" in s or "anyOf" in s) and s.get("type") not in ("string", "integer", "number", "boolean"):
            self.uses_raw = True
            return "json.RawMessage"
        if "const" in s:
            c = s["const"]
            return "bool" if isinstance(c, bool) else "int64" if isinstance(c, int) else "string"
        t = s.get("type")
        if isinstance(t, list):
            rest = [x for x in t if x != "null"]
            if len(rest) != 1:
                self.uses_raw = True
                return "json.RawMessage"
            inner = self.gotype({**s, "type": rest[0]}, hint)
            return inner if inner.startswith(("[]", "map[", "json.RawMessage")) else "*" + inner
        if t == "string":
            return "string"
        if t == "integer":
            return "int64"
        if t == "number":
            return "float64"
        if t == "boolean":
            return "bool"
        if t == "array":
            return "[]" + self.gotype(s.get("items", {}), hint + "Item")
        if t == "object":
            if s.get("properties"):
                self.struct(hint, s)
                return hint
            ap = s.get("additionalProperties")
            if isinstance(ap, dict):
                return "map[string]" + self.gotype(ap, hint + "Value")
            if ap is False:
                return "struct{}"
            return "map[string]any"
        self.uses_raw = True
        return "json.RawMessage"

    # ---------- khai báo ----------
    def comment(self, name: str, s: dict, fallback: str) -> str:
        text = (s.get("description") or s.get("title") or fallback).strip().replace("\n", " ")
        if not text.endswith((".", "!", "?", ")")):
            text += "."
        extra = ""
        if "enum" in s:
            extra = " Giá trị: " + ", ".join(json.dumps(v, ensure_ascii=False) for v in s["enum"]) + "."
        return f"// {name} — {text}{extra}\n"

    def struct(self, name: str, s: dict, doc: str | None = None) -> None:
        if name in self.names:
            return
        self.names.add(name)
        required = set(s.get("required", []))
        fields = []
        for prop, ps in s.get("properties", {}).items():
            fname = camel(prop)
            ftype = self.gotype(ps, name + fname)
            opt = prop not in required
            if opt and not ftype.startswith(("*", "[]", "map[", "json.RawMessage", "struct{}")):
                ftype = "*" + ftype
            tag = f'`json:"{prop}{",omitempty" if opt else ""}"`'
            desc = ps.get("description")
            if "enum" in ps and "$ref" not in ps:
                vals = ", ".join(json.dumps(v, ensure_ascii=False) for v in ps["enum"])
                desc = (desc + " " if desc else "") + f"Giá trị: {vals}."
            line = f"\t{fname} {ftype} {tag}"
            fields.append((f"\t// {desc}\n" if desc else "") + line)
        head = doc if doc is not None else f"// {name} được sinh từ schema.\n"
        self.decls.append(head + f"type {name} struct {{\n" + "\n".join(fields) + "\n}\n")

    def named(self, name: str, s: dict) -> None:
        """Kiểu có tên trong $defs (defs.schema.json, errors.schema.json)."""
        name = camel(name)
        doc = self.comment(name, s, f"kiểu {name} trong contracts/agent-ops.")
        if s.get("type") == "object" and s.get("properties"):
            self.struct(name, s, doc)
            return
        self.names.add(name)
        base = self.gotype(s, name + "Value")
        self.decls.append(doc + f"type {name} {base}\n")

    # ---------- chạy ----------
    def run(self) -> str:
        defs = json.loads((SRC / "defs.schema.json").read_text())["$defs"]
        errors = json.loads((SRC / "errors.schema.json").read_text()).get("$defs", {})
        for n, s in {**defs, **errors}.items():
            self.named(n, s)

        env = json.loads((SRC / "envelope.schema.json").read_text())
        env_props = dict(env["properties"])
        env_props["params"] = {"type": "object", "description": "Tham số của op; kiểu cụ thể là <Op>Params."}
        env_props["op"] = {"type": "string", "description": "Tên op trong catalog (hằng Op*)."}
        self.struct("Envelope", {**env, "properties": env_props}, f"// Envelope — {env['title']} (envelope.schema.json).\n")

        res = json.loads((SRC / "result.schema.json").read_text())
        res_props = dict(res["properties"])
        res_props["data"] = {"type": ["object", "null"], "description": "Kết quả của op; kiểu cụ thể là <Op>Result."}
        res_props["error"] = {**res_props["error"], "type": "object"}
        res_req = list(res.get("required", []))
        self.struct("ResultEnvelope", {**res, "properties": res_props, "required": res_req},
                    f"// ResultEnvelope — {res['title']} (result.schema.json).\n")

        catalog = json.loads((SRC / "catalog.json").read_text())
        entries = catalog["ops"] if isinstance(catalog, dict) else catalog
        consts = []
        ctor_params: list[str] = []
        ctor_result: list[str] = []
        for e in sorted(entries, key=lambda x: x["op"]):
            op = e["op"]
            cname = camel(op)
            consts.append(f'\tOp{cname} = "{op}"')
            f = SRC / "ops" / f"{op}.schema.json"
            if not f.exists():
                continue
            d = json.loads(f.read_text())["$defs"]
            for part, suffix, ctor in (("params", "Params", ctor_params), ("result", "Result", ctor_result)):
                if part in d:
                    self.struct(cname + suffix, d[part], f"// {cname}{suffix} — {part} của op {op} (ops/{op}.schema.json).\n")
                    ctor.append(f"\tcase Op{cname}:\n\t\treturn new({cname}{suffix})")

        imports = 'import "encoding/json"\n\n' if self.uses_raw else ""
        body = (
            "// Code generated by contracts/tools/gen_go_types.py; DO NOT EDIT.\n"
            "// Nguồn: contracts/agent-ops. Sửa contracts rồi chạy: make codegen\n\n"
            "package contracts\n\n" + imports
            + "// Tên op trong catalog.json.\nconst (\n" + "\n".join(consts) + "\n)\n\n"
            + "\n".join(self.decls)
            + "\n// NewParams trả về con trỏ tới struct Params của op, nil nếu op chưa có schema.\n"
            + "func NewParams(op string) any {\n\tswitch op {\n" + "\n".join(ctor_params) + "\n\t}\n\treturn nil\n}\n"
            + "\n// NewResult trả về con trỏ tới struct Result của op, nil nếu op chưa có schema.\n"
            + "func NewResult(op string) any {\n\tswitch op {\n" + "\n".join(ctor_result) + "\n\t}\n\treturn nil\n}\n"
        )
        return gofmt(body)


def gofmt(src: str) -> str:
    exe = shutil.which("gofmt")
    if not exe:
        raise SystemExit("gen_go_types: cần gofmt (cài Go 1.24+)")
    p = subprocess.run([exe], input=src, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit("gen_go_types: gofmt lỗi:\n" + p.stderr)
    return p.stdout


def main() -> int:
    out = Gen().run()
    rel = OUT.relative_to(ROOT)
    if "--check" in sys.argv:
        cur = OUT.read_text() if OUT.exists() else None
        if cur != out:
            print(f"✗ {rel} lệch với contracts/agent-ops — chạy: make codegen", file=sys.stderr)
            return 1
        print(f"✓ {rel} khớp contracts/agent-ops")
        return 0
    OUT.write_text(out)
    print(f"✓ sinh {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
