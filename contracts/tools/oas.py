"""Thư viện nhỏ dựng OpenAPI 3.1 cho ITSO Panel.

Mục tiêu: mọi operation cùng một khuôn (lỗi Problem, phân trang cursor, 202 + Job,
Idempotency-Key) để không lệch giữa các nhóm endpoint. Dùng bởi gen_openapi.py.
"""
from __future__ import annotations

import copy

COMMON = "./common.yaml"


# ---------------------------------------------------------------- schema helpers
def ref(name: str, common: bool = False) -> dict:
    return {"$ref": f"{COMMON}#/components/schemas/{name}" if common else f"#/components/schemas/{name}"}


def cref(name: str) -> dict:
    return ref(name, common=True)


def s(fmt: str | None = None, **kw) -> dict:
    d = {"type": "string"}
    if fmt:
        d["format"] = fmt
    d.update(kw)
    return d


def i(**kw) -> dict:
    return {"type": "integer", **kw}


def n(**kw) -> dict:
    return {"type": "number", **kw}


def b(**kw) -> dict:
    return {"type": "boolean", **kw}


def enum(*vals, **kw) -> dict:
    return {"type": "string", "enum": list(vals), **kw}


def arr(items: dict, **kw) -> dict:
    return {"type": "array", "items": items, **kw}


def nullable(schema: dict) -> dict:
    """OpenAPI 3.1: dùng oneOf null cho $ref, type list cho kiểu nguyên thủy."""
    if "$ref" in schema:
        return {"oneOf": [schema, {"type": "null"}]}
    out = copy.deepcopy(schema)
    t = out.get("type")
    if isinstance(t, str):
        out["type"] = [t, "null"]
    if "enum" in out and None not in out["enum"]:
        out["enum"] = out["enum"] + [None]
    return out


def obj(props: dict, required: list[str] | None = None, desc: str | None = None, extra: bool = False) -> dict:
    d = {"type": "object", "properties": props}
    if required is None:
        required = list(props)
    if required:
        d["required"] = required
    if not extra:
        d["additionalProperties"] = False
    if desc:
        d["description"] = desc
    return d


def map_of(values: dict) -> dict:
    return {"type": "object", "additionalProperties": values}


# ---------------------------------------------------------------- operation builder
class Api:
    """Tích lũy paths cho một file OpenAPI."""

    def __init__(self, prefix: str, realm: str):
        self.prefix = prefix  # /api/v1/admin hoặc /api/v1/portal
        self.realm = realm
        self.paths: dict = {}
        self.op_ids: set[str] = set()

    # -- params dùng chung (trong common.yaml)
    @staticmethod
    def p(name: str) -> dict:
        return {"$ref": f"{COMMON}#/components/parameters/{name}"}

    @staticmethod
    def r(name: str) -> dict:
        return {"$ref": f"{COMMON}#/components/responses/{name}"}

    def _errors(self, method: str, has_id: bool, has_body: bool, job: bool, list_: bool = False) -> dict:
        e = {"401": self.r("Unauthorized"), "403": self.r("Forbidden"), "429": self.r("TooManyRequests")}
        if has_id:
            e["404"] = self.r("NotFound")
        # Danh sách: limit/sort/filter sai → 422 validation_failed.
        if has_body or list_ or method in ("post", "put", "patch"):
            e["422"] = self.r("ValidationFailed")
        if job or method in ("post", "put", "patch", "delete"):
            e["409"] = self.r("Conflict")
        if method == "patch":
            e["412"] = self.r("PreconditionFailed")
        return e

    def add(self, method: str, path: str, op_id: str, summary: str, tag: str, *,
            params: list | None = None, body: dict | None = None, body_example=None,
            ok: dict | None = None, ok_example=None, status: str = "200",
            job: bool = False, job_example=None, list_: bool = False, public: bool = False,
            step_up: bool = False, desc: str | None = None, no_content: bool = False,
            security: list | None = None, content_type: str = "application/json"):
        full = path if path.startswith("/api/") else self.prefix + path
        if op_id in self.op_ids:
            raise SystemExit(f"operationId trùng: {op_id}")
        self.op_ids.add(op_id)
        has_id = "{" in full
        op: dict = {"operationId": op_id, "summary": summary, "tags": [tag]}
        notes = []
        if desc:
            notes.append(desc)
        if step_up:
            notes.append("Yêu cầu step-up MFA (xác thực lại trong 10 phút), nếu không trả 403 `mfa_step_up_required`.")
            op["x-itso-step-up"] = True
        if job:
            notes.append("Thao tác bất đồng bộ: trả `202` kèm Job; bắt buộc header `Idempotency-Key`.")
        if notes:
            op["description"] = "\n\n".join(notes)
        prm = list(params or [])
        if job:
            prm.append(self.p("IdempotencyKey"))
        if method == "patch":
            prm.append(self.p("IfMatch"))
        if list_:
            prm = [self.p("Cursor"), self.p("Limit"), self.p("Sort"), self.p("Q")] + prm
        if prm:
            op["parameters"] = prm
        if body is not None:
            media = {"schema": body}
            if body_example is not None:
                media["example"] = body_example
            op["requestBody"] = {"required": True, "content": {content_type: media}}
        responses: dict = {}
        if job:
            media = {"schema": cref("JobAccepted")}
            if job_example is not None:
                media["example"] = job_example
            responses["202"] = {"description": "Đã nhận, Job được tạo", "content": {"application/json": media}}
        elif no_content:
            responses["204"] = {"description": "Thành công, không có nội dung"}
        else:
            if list_:
                schema = {"allOf": [cref("CursorPage"), obj({"data": arr(ok)}, required=["data"], extra=True)]}
            else:
                schema = obj({"data": ok}, required=["data"], extra=True) if ok is not None else None
            media = {"schema": schema}
            if ok_example is not None:
                media["example"] = ok_example
            desc_ok = {"200": "Thành công", "201": "Đã tạo"}.get(status, "Thành công")
            responses[status] = {"description": desc_ok, "content": {"application/json": media}}
            if status == "200" and method == "get" and has_id and not list_:
                responses[status]["headers"] = {"ETag": {"$ref": f"{COMMON}#/components/headers/ETag"}}
        if not public:
            responses.update(self._errors(method, has_id, body is not None, job, list_))
        else:
            responses["429"] = self.r("TooManyRequests")
            if body is not None:
                responses["422"] = self.r("ValidationFailed")
        op["responses"] = responses
        if public:
            op["security"] = security if security is not None else []
        elif security is not None:
            op["security"] = security
        self.paths.setdefault(full, {})[method] = op
        return op

    # -- khuôn thường gặp
    def crud(self, base: str, name: str, schema: dict, tag: str, examples: list, *,
             ops: str = "lcrud", create_body: dict | None = None, create_example=None,
             update_body: dict | None = None, update_example=None, create_job: bool = False,
             update_job: bool = False, delete_job: bool = False, job_factory=None,
             list_params: list | None = None, delete_step_up: bool = False, plural: str | None = None,
             id_param: str = "Id"):
        plural = plural or name + "s"
        P = name[0].upper() + name[1:]
        Pl = plural[0].upper() + plural[1:]
        item = f"{base}/{{id}}"
        idp = [self.p(id_param)]
        if "l" in ops:
            self.add("get", base, f"list{Pl}", f"Danh sách {plural}", tag, list_=True, ok=schema,
                     ok_example={"data": examples[:3], "meta": {"next_cursor": None, "limit": 50}},
                     params=list_params)
        if "c" in ops:
            if create_job:
                self.add("post", base, f"create{P}", f"Tạo {name}", tag, body=create_body,
                         body_example=create_example, job=True,
                         job_example=job_factory(f"{name}.create", examples[0]) if job_factory else None)
            else:
                self.add("post", base, f"create{P}", f"Tạo {name}", tag, body=create_body,
                         body_example=create_example, ok=schema, ok_example={"data": examples[0]}, status="201")
        if "r" in ops:
            self.add("get", item, f"get{P}", f"Chi tiết {name}", tag, params=idp, ok=schema,
                     ok_example={"data": examples[0]})
        if "u" in ops:
            if update_job:
                self.add("patch", item, f"update{P}", f"Cập nhật {name}", tag, params=idp, body=update_body,
                         body_example=update_example, job=True,
                         job_example=job_factory(f"{name}.update", examples[0]) if job_factory else None)
            else:
                self.add("patch", item, f"update{P}", f"Cập nhật {name}", tag, params=idp, body=update_body,
                         body_example=update_example, ok=schema, ok_example={"data": examples[0]})
        if "d" in ops:
            if delete_job:
                self.add("delete", item, f"delete{P}", f"Xóa {name}", tag, params=idp, job=True,
                         step_up=delete_step_up,
                         job_example=job_factory(f"{name}.delete", examples[0]) if job_factory else None)
            else:
                self.add("delete", item, f"delete{P}", f"Xóa {name}", tag, params=idp, no_content=True,
                         step_up=delete_step_up)
