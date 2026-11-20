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

## 1a. Xác thực (D-58, hiện thực Prompt 3.2)

| Mục | Cách làm |
|---|---|
| Realm | `/api/v1/admin/*` → admin, `/api/v1/portal/*` → portal. `/api/v1/auth/*`: host khớp `ITSO_ADMIN_HOST` / `ITSO_PORTAL_HOST` (production hai origin), ngược lại header `X-ITSO-Realm: admin\|portal` (một origin: dev, demo), mặc định portal. User chỉ được tìm trong đúng realm nên header giả mạo không mở được tài khoản realm khác |
| Phiên | Cookie `itso_admin_session` / `itso_portal_session` (HttpOnly, SameSite=Lax), driver `itso` ghi bảng `sessions` kèm `realm`, `mfa_verified_at`. Hai SPA chung origin không ghi đè phiên của nhau. `remember=false` → cookie hết khi đóng trình duyệt |
| CSRF | `GET /auth/csrf` gắn cookie `XSRF-TOKEN-ADMIN` / `XSRF-TOKEN-PORTAL`; mọi request ghi gửi lại giá trị cookie qua header `X-XSRF-TOKEN`. Thiếu hoặc sai → `419 csrf_mismatch` |
| Đăng nhập | argon2id. Sai email, sai mật khẩu, sai realm, tài khoản khóa: cùng một lỗi `422` (`errors.email`). Khóa lũy tiến theo (realm, email) từ lần sai thứ 5 và theo IP từ lần thứ 20: khóa 1, 2, 4… phút (tối đa 60), trả `429 rate_limited` + `Retry-After` |
| MFA | TOTP RFC 6238 (SHA-1, 6 số, 30 giây, lệch ±1 bước, chặn dùng lại bước đã dùng) + 10 mã khôi phục dùng một lần (băm argon2id). `enroll` trả secret một lần, `confirm` mới lưu (secret mã hóa APP_KEY). User đã bật TOTP phải `mfa/verify` sau login, nếu không mọi API khác trả `403 mfa_required`. SUPER_ADMIN chưa bật MFA: login trả `mfa_required: true, mfa_methods: []`, chỉ còn `me`, đăng ký TOTP, đăng xuất. Nhập sai quá 5 lần/phút → `429` |
| Step-up | `POST /auth/step-up` đặt mốc xác thực lại; route nhạy cảm gắn middleware `itso.step-up` yêu cầu mốc trong 10 phút, ngược lại `403 mfa_step_up_required`. Token API không dùng được thao tác nhạy cảm |
| Phiên của tôi | `GET /auth/sessions` (realm hiện tại, `uuid` là băm của session id, không lộ id thật), `DELETE /auth/sessions/{id}` thu hồi phiên khác (phiên hiện tại → `409`, dùng logout) |
| Mật khẩu | `password:change` thu hồi các phiên khác. `password:forgot` luôn `204`, gửi mail (driver `log` ở dev) link `{ITSO_PORTAL_URL\|ITSO_ADMIN_URL}/reset-password?token=…&email=…`; token 64 ký tự, chỉ lưu SHA-256 trong cache, dùng một lần, hết hạn 60 phút; đặt lại xong thu hồi mọi phiên |
| IP allowlist | Bảng `ip_allowlist`: scope `admin` áp cho realm admin (cả `/auth/*` khi realm admin), scope `api` áp thêm cho request bằng token. Danh sách trống = không giới hạn. Ngoài danh sách → `403 ip_not_allowed` |
| API token | `Authorization: Bearer itso_…` chỉ cho realm admin; lưu SHA-256, kiểm `expires_at`, `allowed_cidrs`, user admin còn active; không cần CSRF/MFA. Route kiểm scope bằng `itso.scope:<nhóm>:read\|write` (`write` bao gồm `read`). Tạo/thu hồi token qua `/admin/api-tokens` (Prompt 3.3) |

## 1b. Phân quyền (Prompt 3.3)

| Mục | Cách làm |
|---|---|
| Quyền | Danh mục ở `apps/api/app/Auth/Permissions.php` (seed `PermissionSeeder`): SUPER_ADMIN `*`; ADMIN `users.read/write`, `roles.read`, `servers.read`, `packages.read`, `accounts.read/write`, `jobs.read/write`, `audit.read`, `websites.*`, `databases.*`, `backups.read`; USER `own.*`. Route gắn `itso.perm:<quyền>`; thiếu → `403 forbidden` |
| Phạm vi ADMIN | `user_scopes` (server \| hosting_account). ADMIN thấy account trên server trong phạm vi hoặc account được giao, thấy USER Portal sở hữu các account đó hoặc do mình tạo. Ngoài phạm vi → `404` (không lộ sự tồn tại). USER chỉ thấy tài nguyên `owner_user_id` của mình |
| Token API | Ngoài quyền của user, token phải có scope tương ứng: `users.read` → `users:read`, hành động khác → `users:write` |
| Users | ADMIN chỉ tạo/sửa/khóa USER Portal trong phạm vi; đổi vai trò và gán phạm vi chỉ SUPER_ADMIN; luôn còn ít nhất một SUPER_ADMIN đang hoạt động (`409`); không tự khóa. `PATCH` trả `ETag`, gửi `If-Match` sai → `412`. Mời user (`send_invite`) gửi link đặt mật khẩu 72 giờ. Khóa → thu hồi mọi phiên; mở khóa → xóa bộ đếm đăng nhập sai; reset MFA (step-up) → xóa TOTP + mã khôi phục + phiên |
| Giả danh | D-61: vé một lần 60 giây → `portal_url` (`{ITSO_PORTAL_URL}/impersonate?ticket=…`) → `POST /auth/impersonation:accept`; phiên 30 phút; `Me.impersonating` = người giả danh |
| Ma trận kiểm thử | `apps/api/tests/Feature/Rbac/MatrixTest.php`: mỗi endpoint × SA / ADMIN trong phạm vi / ADMIN ngoài phạm vi / USER; Prompt 3.4–3.5 thêm dòng cho endpoint mới |

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
