# API — ITSO Panel (phạm vi nội bộ, chốt 2026-11-20)

## 0. Contracts chính thức (Prompt 1.4)

| Nội dung | File |
|---|---|
| Admin API (219 operation) | [contracts/openapi/itso-admin-v1.yaml](contracts/openapi/itso-admin-v1.yaml) |
| Portal API (100 operation) | [contracts/openapi/itso-portal-v1.yaml](contracts/openapi/itso-portal-v1.yaml) |
| Thành phần chung (Problem, CursorPage, Job, security) | [contracts/openapi/common.yaml](contracts/openapi/common.yaml) |
| Agent typed operations (61 op có schema, 23 op khai báo cho Phase 4–10) | [contracts/agent-ops/](contracts/agent-ops/README.md), [catalog.json](contracts/agent-ops/catalog.json) |
| Input độc hại dùng chung cho test | [contracts/test-vectors/evil-inputs.json](contracts/test-vectors/evil-inputs.json) (93 vector) |
| Dữ liệu demo (example, MSW Phase 2) | [contracts/examples/demo-dataset.json](contracts/examples/demo-dataset.json) |
| Quy ước và cách sửa | [contracts/README.md](contracts/README.md) |
| Kiểm tra | `make contracts-check`; HTML docs: `make contracts-docs` → `docs/api/` |

Khi bảng dưới đây khác contract, **contract là chuẩn**. Ghi chú so với bảng dưới: DNS chỉ có ở Admin API (portal không quản lý DNS theo sitemap); job theo dõi qua `GET /…/jobs/{id}/events` (SSE).

> Quy ước chung (RFC 9457, cursor pagination, `202` + Job, `Idempotency-Key`, ETag, rate limit, job model, retry/timeout/cancel) giữ nguyên theo `docs/planning/05-API.md`. File này ghi **cấu trúc bề mặt API** cho phạm vi nội bộ.

## 1. Ba nhóm route

| Nhóm | Prefix | Ai dùng | Truy cập | Contract |
|---|---|---|---|---|
| **Admin API** | `/api/v1/admin/*` | Private Admin Panel (SUPER_ADMIN, ADMIN) và API token nội bộ có scope | Chỉ từ origin admin + IP allowlist; MFA; step-up cho thao tác nguy hiểm | `contracts/openapi/itso-admin-v1.yaml` |
| **Portal API** | `/api/v1/portal/*` | User Hosting Portal (USER) | Public qua Internet; session cookie + CSRF; rate limit; CAPTCHA sau khi đăng nhập sai; WAF | `contracts/openapi/itso-portal-v1.yaml` |
| Chung | `/api/v1/auth/*`, `/api/v1/system/health` | Cả hai, auth theo realm của origin | | trong cả hai file |
| ~~Provisioning~~ | `/api/provisioning/*` | — | **Giữ chỗ, chưa mở (DEFERRED)**. Middleware trả `404` | — |

**Không có:** Public Provisioning API, HMAC integration với website bán hàng, webhook cho billing, endpoint order/invoice/payment.

## 2. Hosting Provisioning Service (lớp nội bộ)

Đây là lớp domain service trong Laravel (`app/Domain/Hosting/ProvisioningService`), không phải một endpoint. Các method: `createAccount`, `changePackage`, `suspend`, `unsuspend`, `migrate`, `terminate`, `schedulePurge`, `confirmPurge`. Mỗi method kiểm tra quyền và quota, ghi desired state, tạo Job, ghi audit.
Admin controller, CLI `itso account …` (gọi qua Admin API bằng token cục bộ) và scheduler đều đi qua lớp này. Một Public API trong tương lai chỉ cần thêm controller mỏng gọi lại lớp này.

## 3. Admin API (chính)

| Nhóm | Endpoint |
|---|---|
| Servers | `GET/POST /admin/servers`, `GET/PATCH /admin/servers/{id}`, `POST /admin/servers/enrollment-tokens`, `GET /admin/servers/{id}/capacity`, services, software, reboot |
| Placement | `GET /admin/placement/suggestions?package=&group=`: trả danh sách server được gợi ý kèm lý do. Không tự cấp |
| Packages | `GET/POST /admin/hosting-packages`, `PATCH` (tạo version mới), `POST /admin/hosting-packages/{id}/versions/{v}:migrate-accounts` |
| Accounts | `GET/POST /admin/hosting-accounts`, `GET/PATCH /admin/hosting-accounts/{id}`, `POST …:suspend` `{reason}`, `:unsuspend`, `:change-package`, `:migrate` `{target_server_id}`, `:terminate`, `:schedule-purge`, `:confirm-purge`, `GET …/usage`, `GET …/lifecycle-events` |
| Migrations | `GET /admin/account-migrations`, `GET /admin/account-migrations/{id}`, `POST …:cutover`, `POST …:rollback` |
| Users | `GET/POST /admin/users`, `PATCH`, `:lock`, `:unlock`, `:reset-mfa`, `:impersonate` `{reason}`, `PUT /admin/users/{id}/scopes` |
| Websites, Databases, Files, SFTP, Cron, SSL, DNS | Như 05, đặt dưới `/admin/…`, áp dụng cho mọi account trong phạm vi |
| Security, Firewall, WAF, Malware | `/admin/security/*`, `/admin/servers/{id}/firewall/*` |
| Backup/Restore | `/admin/backup-destinations`, `/admin/backup-policies`, `/admin/backup-snapshots`, `/admin/restores` (kể cả restore sang server khác) |
| Docker | `/admin/servers/{id}/docker/*`, `/admin/compose-projects` |
| WordPress | `/admin/wordpress/*` |
| Git deploy | `GET/POST /admin/git-repositories`, `GET/PATCH/DELETE …/{id}`, `POST …:rotate-webhook-secret`, `GET/POST …/{id}/deployments`, `POST /admin/git-deployments/{id}:rollback`. Webhook công khai `POST /hooks/git/{token}` (HMAC) để Phase 10 |
| Monitoring, Audit, Jobs, Settings, Notifications | `/admin/metrics/*`, `/admin/alert-rules`, `/admin/audit-logs`, `/admin/jobs`, `/admin/settings/*` |
| Terminal | `POST /admin/terminal/sessions` (root terminal chỉ chạy khi policy cục bộ cho phép) |

## 4. Portal API (USER, chỉ trên tài nguyên của mình)

| Nhóm | Endpoint |
|---|---|
| Tổng quan | `GET /portal/overview`: usage so với quota, cảnh báo |
| Accounts | `GET /portal/hosting-accounts`, `GET /portal/hosting-accounts/{id}`, `GET …/usage` (chỉ đọc; không tự đổi gói) |
| Websites | `GET/POST/PATCH/DELETE /portal/websites`, domains, PHP version (trong phạm vi gói), SSL |
| Databases | `GET/POST/DELETE /portal/databases`, `/portal/database-users`, export/import |
| Files | `/portal/hosting-accounts/{id}/files*` |
| SFTP / SSH keys | `/portal/sftp-accounts`, `/portal/ssh-keys` |
| Cron | `/portal/cron-jobs` |
| Backups | `GET /portal/backup-snapshots`, `POST /portal/backups` (trong quota), `POST /portal/restores`, `POST /portal/backup-snapshots/{id}:download-link` |
| WordPress | `/portal/wordpress/*` |
| Git deploy | `/portal/git-repositories*`, `/portal/git-deployments/{id}:rollback` (khi gói cho phép) |
| Terminal | `POST /portal/terminal/sessions` (chỉ khi gói cho SSH; shell trong jail) |
| Jobs, Notifications, Profile | `/portal/jobs/{id}`, `/portal/notifications`, `/portal/profile`, `/portal/mfa/*`, `/portal/sessions` |

Portal **không có**: servers, packages, users, firewall, docker, software, settings hệ thống. Truy cập tài nguyên không thuộc mình trả `404`.

## 5. Thao tác bất đồng bộ

Mọi thao tác chạm Linux (tạo/khóa/mở/đổi gói/chuyển server/xóa, website, DB, backup…) trả `202` kèm `job`. Bắt buộc `Idempotency-Key`. Hủy qua `POST /…/jobs/{id}:cancel`, chạy lại job lỗi qua `POST /…/jobs/{id}:retry`. Theo dõi tiến độ qua SSE `/…/jobs/{id}/events`. Mọi thao tác đều được audit.
