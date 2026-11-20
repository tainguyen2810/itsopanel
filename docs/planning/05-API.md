# 05 — Thiết kế REST API `/api/v1` (mức kiến trúc)

> **Phạm vi chốt 2026-11-20 (nội bộ):** bản tổng hợp hiện hành nằm ở `seed/API.md`. File này vẫn là chi tiết kỹ thuật; phần nào mâu thuẫn thì theo `seed/API.md`.

Nguồn sự thật: `contracts/openapi/itso-api-v1.yaml` (viết trước, code sau). Frontend sinh type TS từ OpenAPI; MSW mock dùng cùng spec ở Phase 2.

## 1. Quy ước chung

| Chủ đề | Quy ước |
|---|---|
| Base | `https://<panel>/api/v1` |
| Định danh | `uuid` trong URL (`/websites/0193…`) |
| Định dạng | JSON; lỗi theo **RFC 9457** `application/problem+json` `{type, title, status, detail, code, errors{field:[...]}}` |
| Phân trang | Cursor: `?cursor=&limit=50` → `{data:[], meta:{next_cursor}}` |
| Lọc/sắp xếp | `?filter[status]=ready&sort=-created_at&q=` |
| Hành động không phải CRUD | `POST /resource/{id}:action` (vd `:suspend`, `:renew`) |
| Bất đồng bộ | Thao tác chạm Linux trả **`202 Accepted`** `{job:{uuid, state, links.self}, resource:{...}}` |
| Idempotency | Header `Idempotency-Key` (UUID) **bắt buộc** cho mọi POST tạo job; lưu 24h; trùng key + cùng body → trả lại response cũ; khác body → `409` |
| Concurrency | `ETag`/`If-Match` (dựa trên `spec_version`) cho PATCH tài nguyên hệ thống → `412` khi xung đột |
| Rate limit | `429` + `Retry-After`; mặc định 120 req/phút/user, login 5/phút/IP+email |
| Version | Breaking change → `/api/v2`; thêm field không phá vỡ |
| i18n | `Accept-Language: vi|en` cho message lỗi |

## 2. Authentication & Authorization

- **SPA:** Laravel Sanctum **cookie session** cùng origin + CSRF (`XSRF-TOKEN`), cookie `Secure; HttpOnly; SameSite=Strict`. Không lưu token trong localStorage.
- **Automation:** API token (Bearer) có **scopes** + hết hạn; không dùng được cho endpoint nhạy cảm (users, security, terminal) trừ khi scope cho phép.
- **MFA:** TOTP bắt buộc với SA/AD (cấu hình). **Step-up:** hành động nguy hiểm (reboot, xóa account, terminal root, đổi SSH, restore overwrite, xóa backup) yêu cầu `mfa_verified_at` < 10 phút → nếu không, `403 {code:"mfa_step_up_required"}`.
- **Authorization:** Laravel Policy cho mỗi model + global scope theo tenant. Quy tắc trả `404` (không phải 403) khi user truy cập tài nguyên ngoài phạm vi để không lộ sự tồn tại.

| Endpoint | Mô tả |
|---|---|
| `GET /auth/csrf` | Lấy cookie CSRF |
| `POST /auth/login` | email + password → `{mfa_required}` |
| `POST /auth/mfa/verify` | TOTP/recovery |
| `POST /auth/logout` | |
| `GET /auth/me` | user, role, permissions, scopes, preferences |
| `POST /auth/mfa/totp:enroll` · `:confirm` · `DELETE /auth/mfa/totp` | |
| `GET /auth/sessions` · `DELETE /auth/sessions/{id}` | |
| `POST /auth/password:change` · `/auth/password:forgot` · `/auth/password:reset` | |
| `POST /auth/step-up` | xác thực lại MFA |

## 3. Nhóm endpoint

| Nhóm | Endpoint chính |
|---|---|
| **Servers** | `GET/POST /servers`, `GET/PATCH /servers/{id}`, `GET /servers/{id}/services`, `POST /servers/{id}/services/{name}:start\|stop\|restart`, `POST /servers/{id}:reboot`, `POST /servers/enrollment-tokens`, `GET /servers/{id}/software`, `POST /servers/{id}/software/{key}:install\|remove\|upgrade` |
| **Hosting Packages** | `GET/POST /hosting-packages`, `GET/PATCH/DELETE /hosting-packages/{id}`, `POST /hosting-packages/{id}:clone` |
| **Hosting Accounts** | `GET/POST /hosting-accounts`, `GET/PATCH/DELETE /hosting-accounts/{id}`, `POST …:suspend\|unsuspend\|change-package`, `GET …/usage` |
| **Users** | `GET/POST /users`, `GET/PATCH/DELETE /users/{id}`, `POST /users/{id}:lock\|unlock\|impersonate\|reset-mfa`, `PUT /users/{id}/scopes`, `GET /roles`, `GET/POST/DELETE /api-tokens` |
| **Websites** | `GET/POST /websites`, `GET/PATCH/DELETE /websites/{id}`, `POST …:suspend\|unsuspend`, `GET/POST/DELETE /websites/{id}/domains`, `GET/PATCH /websites/{id}/nginx\|php\|waf`, `GET /websites/{id}/logs` |
| **SSL / DNS** | `GET /certificates`, `POST /websites/{id}/certificates`, `POST /certificates/{id}:renew`, `DELETE /certificates/{id}`, `GET/POST /dns/providers`, `GET /dns/zones`, `GET/POST/PATCH/DELETE /dns/zones/{id}/records` |
| **Databases** | `GET/POST /databases`, `DELETE /databases/{id}`, `POST /databases/{id}:export\|import`, `GET/POST/DELETE /database-users`, `POST /database-users/{id}:rotate-password`, `PUT /databases/{id}/grants` |
| **Files** | `GET /hosting-accounts/{id}/files?path=` (list), `GET …/files/content?path=`, `PUT …/files/content`, `POST …/files/uploads` (tạo session) + `PATCH …/files/uploads/{uid}` (chunk), `GET …/files/download?path=` (signed URL ngắn hạn), `POST …/files:mkdir\|move\|copy\|delete\|chmod\|compress\|extract` |
| **SFTP / SSH keys** | `GET/POST/DELETE /sftp-accounts`, `GET/POST/DELETE /ssh-keys` |
| **Cron** | `GET/POST/PATCH/DELETE /cron-jobs`, `POST /cron-jobs/{id}:run`, `GET /cron-jobs/{id}/runs` |
| **Docker** | `GET /servers/{id}/docker/containers`, `POST …/containers/{cid}:start\|stop\|restart`, `GET …/containers/{cid}/logs`, `GET/POST/DELETE …/docker/images\|volumes\|networks`, `GET/POST/PATCH/DELETE /compose-projects`, `POST /compose-projects/{id}:validate\|up\|down\|pull`, `GET/POST /registries` |
| **Backups** | `GET/POST/PATCH /backup-destinations`, `POST /backup-destinations/{id}:test`, `GET/POST/PATCH/DELETE /backup-policies`, `POST /backup-policies/{id}:run`, `GET /backup-snapshots`, `GET /backup-snapshots/{id}/browse`, `POST /restores`, `GET /restores/{id}` |
| **Security** | `GET /security/overview`, `GET/POST/DELETE /servers/{id}/firewall/rules`, `POST /servers/{id}/firewall:apply`, `GET/PATCH /security/ssh`, `GET/PATCH /security/fail2ban`, `GET /security/events`, `POST /security/events/{id}:acknowledge`, `POST /websites/{id}/scans`, `GET /quarantine`, `POST /quarantine/{id}:restore`, `GET/PUT /security/ip-allowlist` |
| **Jobs** | `GET /jobs`, `GET /jobs/{id}` (gồm steps), `GET /jobs/{id}/logs`, `POST /jobs/{id}:cancel`, `POST /jobs/{id}:retry`, `GET /jobs/{id}/events` (SSE qua gateway) |
| **Audit / Activity** | `GET /audit-logs`, `GET /audit-logs/export`, `GET /activity` |
| **Monitoring** | `GET /dashboard/summary`, `GET /metrics/servers/{id}`, `GET /metrics/hosting-accounts/{id}`, `GET/POST/PATCH /alert-rules`, `GET /alerts` |
| **Notifications / Settings** | `GET /notifications`, `POST /notifications/{id}:read`, `POST /notifications:read-all`, `GET/PATCH /notification-preferences`, `GET/PATCH /settings/{group}` |
| **Terminal** | `POST /terminal/sessions` → `{ticket, ws_url}` (ticket 30s, một lần) |
| **System** | `GET /system/health` (không auth: chỉ `ok`), `GET /system/version`, `GET /system/updates` |

## 4. Mô hình Job

```json
{
  "uuid": "0193d8c2-...",
  "type": "website.provision",
  "state": "running",
  "progress": 60,
  "resource": {"type": "website", "uuid": "..."},
  "steps": [
    {"seq":1,"op":"account.ensure","state":"succeeded"},
    {"seq":2,"op":"php.pool.apply","state":"succeeded"},
    {"seq":3,"op":"nginx.vhost.apply","state":"running"},
    {"seq":4,"op":"cert.issue","state":"pending"}
  ],
  "attempts": 1, "max_attempts": 3, "timeout_sec": 600,
  "error": null,
  "created_at": "...", "started_at": "...", "finished_at": null
}
```

| Cơ chế | Thiết kế |
|---|---|
| **Idempotency** | API: `Idempotency-Key`. Worker → Agent: `op_id = job_uuid:seq:attempt_group`; agent cache kết quả theo `op_id`. Mọi op viết dạng "ensure/apply" nên chạy lại an toàn. |
| **Retry** | Theo bước: lỗi tạm thời (agent không phản hồi, apt lock, ACME rate) → backoff mũ (10s, 30s, 90s). Lỗi validation/policy → không retry. |
| **Timeout** | Mỗi bước có deadline truyền xuống agent (context cancellation); job có timeout tổng; vượt → `timed_out` + compensation. |
| **Cancellation** | `POST /jobs/{id}:cancel` → `cancel_requested`; worker kiểm tra giữa các bước và gửi `op.cancel{op_id}` cho agent; bước không thể ngắt an toàn (vd đang `nft -f`) hoàn tất rồi mới dừng. |
| **Khóa tài nguyên** | Redis lock `lock:website:{uuid}` — chỉ một job mutation chạy trên một tài nguyên; job sau xếp hàng. |
| **Audit** | Tạo job, mỗi bước, kết quả cuối → `audit_logs` với `job_id`. |
| **Push tiến độ** | Worker publish Redis `jobs:{uuid}` → gateway → SSE `GET /jobs/{id}/events`; fallback polling 2s. |

## 5. Xác thực đầu vào (nhắc lại vì quan trọng)
- Validate ở **cả** Laravel (nghiệp vụ, quyền, quota) **và** Agent (schema, ký tự, đường dẫn) — Agent không tin Laravel.
- Domain: lowercase, IDNA → punycode, regex RFC 1123, cấm `localhost`, IP, tên panel.
- Username Linux: `^[a-z][a-z0-9]{2,15}$`, cấm danh sách hệ thống (root, www-data, mysql, itso…).
- Đường dẫn file: luôn **tương đối** với home account, không chứa NUL; chuẩn hóa ở agent.
