# contracts — nguồn sự thật cho REST và Agent

Contracts viết **trước** code (CLAUDE.md §2). Frontend sinh type TS, Laravel và Go validate theo đúng các file ở đây.

| Thư mục | Nội dung | Số liệu (Prompt 1.4) |
|---|---|---|
| `openapi/` | OpenAPI 3.1: `itso-admin-v1.yaml`, `itso-portal-v1.yaml`, `common.yaml` (Problem, CursorPage, Job, tham số, security, mẫu ràng buộc) | admin 208 operation, portal 90 operation |
| `agent-ops/` | JSON Schema 2020-12: `envelope`, `result`, `errors`, `defs`, `ops/<op>.schema.json`, `catalog.json` | 60 op có schema (Phase 4–9), 21 op khai báo (Phase 7–10) |
| `test-vectors/` | `evil-inputs.json`: input độc hại + kết quả mong đợi, dùng chung cho test PHP và Go | 93 vector |
| `examples/` | `demo-dataset.json`: dữ liệu demo dùng cho example và MSW mock ở Phase 2 | |
| `tools/` | Bộ sinh (`gen_openapi.py`, `gen_agent_ops.py`, `gen_vectors.py`) và bộ kiểm (`check_contracts.py`) | |

## Quy trình sửa contract

1. Sửa nguồn trong `tools/`: `schemas.py` (schema), `gen_openapi.py` (path), `demo.py` (dữ liệu example), `gen_agent_ops.py` (op agent), `gen_vectors.py` (vector).
2. `make contracts` sinh lại YAML/JSON. File sinh ra **được commit** và là contract chính thức; không sửa tay.
3. `make contracts-check` phải PASS trước khi commit.

## Quy ước bắt buộc (được kiểm tự động)

| Quy tắc | Kiểm bởi |
|---|---|
| Mọi operation có `operationId` duy nhất, có summary, có tag | Redocly (`redocly.yaml`) + `check_contracts.py` |
| Mọi lỗi 4xx/5xx dùng `application/problem+json` với schema `Problem` (RFC 9457) | Redocly + `check_contracts.py` |
| Thao tác chạm Linux trả `202` + `JobAccepted` và **bắt buộc** `Idempotency-Key`; ngược lại không có 202 nào thiếu header | `check_contracts.py` |
| Portal chỉ có `/api/v1/portal/*`, `/api/v1/auth/*`, `/api/v1/system/*`; không có tài nguyên/tag admin-only (server, gói, user, firewall, Docker, phần mềm, cài đặt, audit, DNS...) | `check_contracts.py` |
| Không có `/api/provisioning/*` (DEFERRED) | `check_contracts.py` |
| Mọi example hợp lệ với schema; độ phủ example ≥ 95% operation có body | Redocly + `check_contracts.py` |
| Op trong các bước Job của example có trong `agent-ops/catalog.json` | `check_contracts.py` |
| Mẫu ràng buộc (Domain, Username, RelPath, DbName, CronExpr...) giống nhau giữa OpenAPI và agent; mọi pattern tương thích RE2 (Go, không lookahead) | `check_contracts.py` |
| Schema agent compile ở ajv strict; envelope mẫu hợp lệ được chấp nhận, mẫu không hợp lệ bị từ chối | ajv-cli + `check_contracts.py` |
| Vector tầng `schema` trong `evil-inputs.json` cho kết quả đúng kỳ vọng | `check_contracts.py` |

Vector tầng `semantic` (ví dụ `admin.itso.local` trùng domain panel, DB thiếu tiền tố username, cron mỗi phút vượt gói) schema không tự quyết được: test Laravel (Phase 3) và Go agent (Phase 4–6) phải dùng lại chúng.

## Tài liệu HTML

`make contracts-docs` dựng `docs/api/itso-admin-v1.html` và `docs/api/itso-portal-v1.html` bằng Redocly (không commit vì lớn, khoảng 1 MB).
