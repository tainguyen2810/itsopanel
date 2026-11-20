# Báo cáo Phase 3 — Auth, RBAC, Users, Packages, Accounts, Jobs, Audit

- **Trạng thái:** ✓ hoàn tất. Nhánh `phase-3`, merge `--no-ff` vào `main` ở Git local (không push, không remote).
- **Thời gian:** 2026-11-20.
- **Phạm vi giữ đúng:** backend thật (Laravel 13 + PostgreSQL 16 + Redis) cho danh tính, phân quyền, người dùng, gói, tài khoản hosting (mức dữ liệu + job tới **mock agent**), Job, Audit, thông báo in-app, cài đặt. Không thao tác hệ thống thật, không deploy. Laravel không chạy lệnh hệ thống (`check-no-exec` xanh). Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED.
- **Quyết định đề xuất chờ duyệt:** D-58 (xác thực SPA, MFA), D-59 (Pest trên PostgreSQL), D-60 (Job runner), D-61 (giả danh bằng vé một lần), D-62 (vòng đời account desired/observed, 501 cho purge/migrate).

## 1. Đã làm

| Prompt | Kết quả chính | Commit |
|---|---|---|
| 3.1 Schema | Migration 26 bảng Phase 3 sinh từ đặc tả (DBML + `extras.sql`: trigger realm bất biến, version gói bất biến, audit append-only + hash chain, CHECK vòng đời), model, factory, Pest trên PostgreSQL; so khớp schema migrate với đặc tả | 3afe712 |
| 3.2 Auth | CSRF theo realm, đăng nhập theo realm (sai realm = sai mật khẩu), khóa lũy tiến, argon2id, MFA TOTP tự viết + 10 mã khôi phục, step-up, phiên (list/thu hồi), đổi/quên/đặt lại mật khẩu, IP allowlist Admin, API token | afa74ab, 7a6b371 |
| 3.3 RBAC | Vai trò/quyền, phạm vi ADMIN (server, account), Policies, global scope Portal, Users API (khóa/mở, reset MFA, scopes), giả danh có lý do, ma trận quyền tự động | 4406e7e |
| 3.4 Nền vận hành | JobRunner (bước, retry backoff, hủy, timeout, op_id `uuid:seq:attempt`), Idempotency-Key, audit hash chain + xuất CSV + `itso:audit-verify`, thông báo in-app, cài đặt (ETag, step-up), servers (seed `srv-local` từ mock agent), dashboard | c322082 |
| 3.5 Hosting | Gói + phiên bản bất biến, Hosting Provisioning Service (tạo/khóa/mở/chấm dứt/khôi phục/đổi gói/override), cấp UID (không tái dùng 90 ngày), quota phía panel (422 `quota_exceeded`), API Portal (account, overview, profile, job, thông báo), `itso:usage-refresh` | bff7f16 |
| 3.6 Nối UI | Client gửi CSRF + header realm, thử lại một lần khi 419, 401 → về đăng nhập đúng realm; phiên thật thay persona ở bản build thường (loading/anonymous/mfa/enroll/ready); trang của Phase sau hiện "Chưa có ở bản này" (404 `not_available`, 501); DemoSeeder; `make dev` thêm queue worker + đăng ký server + reconcile; `itso:reconcile`; Playwright trên stack thật | 59cb935 |

## 2. File chính

| Phần | Vị trí |
|---|---|
| Xác thực, MFA | `apps/api/app/Auth/`, `app/Http/Controllers/Api/V1/Auth/` |
| Phân quyền, phạm vi | `apps/api/app/Domain/Access/`, `app/Policies/`, `app/Http/Middleware/` |
| Job, agent | `apps/api/app/Domain/Jobs/`, `app/Infrastructure/Agent/`, `app/Jobs/RunJob.php` |
| Hosting | `apps/api/app/Domain/Hosting/` (`ProvisioningService`, `AccountLifecycle`, `QuotaService`, `UidAllocator`, `PackageLimits`) |
| Audit, thông báo, server | `apps/api/app/Domain/{Audit,Notifications,Servers}/` |
| Lệnh artisan | `itso:server-local`, `itso:reconcile`, `itso:usage-refresh`, `itso:audit-verify` |
| Dữ liệu demo | `apps/api/database/seeders/DemoSeeder.php` |
| Client theo realm | `apps/web/src/api/realm-http.ts`, `src/shared/session/SessionContext.tsx`, `src/shared/routing/AppLayout.tsx` |
| E2E stack thật | `apps/web/e2e-real/phase3.spec.ts`, `apps/web/playwright.real.config.ts` |
| Runbook | `docs/runbooks/phase-3-demo.md` |

## 3. Cách chạy thử

Xem `docs/runbooks/phase-3-demo.md`: `make dev`, seed `DemoSeeder`, tài khoản dev (mật khẩu `password-dev-only`, secret TOTP dev của Super Admin), `make test-e2e-real`.

## 4. Kết quả test

`make check` (2026-11-20, PostgreSQL 16 + Redis cục bộ): **20 PASS · 1 SKIP (staticcheck) · 0 FAIL**, git-clean PASS. Chi tiết từng bước ở `TEST_REPORT.md` (Prompt 3.6).

| Bộ test | Kết quả |
|---|---|
| Pest (PostgreSQL 16 + Redis) | 292/292, 2095 assertion |
| Vitest | 457/457 |
| Playwright (demo MSW + Design System) | 259/259 |
| Playwright stack thật (`make test-e2e-real`) | 4/4 |
| pint, phpstan, ESLint, Prettier, tsc, i18n | xanh |

E2E stack thật (Laravel + PostgreSQL + Redis + mock agent + Vite không MSW):

1. Admin đăng nhập có MFA: chưa xác minh MFA thì route có shell đưa về bước MFA; mã sai bị từ chối; mã đúng vào dashboard.
2. Tạo user portal → tạo gói → tạo account cho user đó qua wizard → job chạy qua mock agent → "Hoạt động" → tạm khóa (job xong) → mở khóa (job xong).
3. Portal (`it@anphat.vn`): chỉ thấy `anphat`, `oldshop`; API account của người khác trả 404; mở thẳng URL account người khác hiện "Không tìm thấy".
4. Sai realm: phiên Portal gọi API Admin nhận 401, trang Admin đòi đăng nhập; user portal không đăng nhập được Admin Panel.

## 5. Tiêu chí nghiệm thu Phase 3

| Tiêu chí | Kết quả | Bằng chứng |
|---|---|---|
| USER không đọc được tài nguyên người khác (404) qua bất kỳ endpoint nào | ✓ | `tests/Feature/Rbac/MatrixTest.php` (ma trận Portal: US_OTHER nhận 404 trên mọi endpoint có id), `HostingTest` (Portal), `JobsTest` (phạm vi job), `EndpointGapsTest` (job events/retry), e2e 3 |
| ADMIN chỉ thấy phạm vi | ✓ | `MatrixTest` (AD_IN/AD_OUT trên mọi endpoint admin), danh sách user theo phạm vi, `PlatformApiTest` (audit, servers), `EndpointGapsTest` (gợi ý server) |
| SA bắt buộc MFA | ✓ | `MfaTest` (SA chưa bật MFA chỉ gọi được me/enroll/logout), UI trạng thái `enroll` chỉ vào Hồ sơ, e2e 1 |
| Vượt quota bị từ chối 422 | ✓ | `HostingTest` (đổi gói + quota, `QuotaService::ensureCanAdd`) |
| Job retry/cancel hoạt động với mock | ✓ | `JobsTest` (retry tự động khi lỗi tạm thời, tới max_attempts, retry qua API cần Idempotency-Key và không chạy lại bước đã xong, hủy queued/running, timeout), `HostingTest` (tạo account lỗi → retry → active) |
| Coverage backend module Phase 3 ≥ 80% | ⚠ không đo được bằng công cụ | xem mục 6 |

## 6. Coverage

Môi trường không có pcov/xdebug, và việc tự build pcov trong container bị chặn bởi chính sách môi trường, nên **không có số % coverage**. Theo đúng yêu cầu prompt, thay bằng đối chiếu endpoint:

- `php artisan route:list --path=api/v1`: **87 route** (admin 55, auth 15, portal 16, system 1).
- Đối chiếu từng route với đường dẫn gọi trong `apps/api/tests`: **87/87 route có test gọi tới** (trước 3.6 là 80/87; 7 route còn thiếu được bổ sung trong `tests/Feature/Platform/EndpointGapsTest.php` và `PlatformApiTest`: 3 route trả 501, gợi ý đặt account, đánh dấu đã đọc thông báo Admin, luồng sự kiện và chạy lại job ở Portal).
- Mọi response trong test được kiểm với OpenAPI (`assertMatchesContract`).
- Nhánh đã có test theo module:

| Module | Nhánh có test |
|---|---|
| Auth | đúng/sai mật khẩu, sai realm, khóa lũy tiến, CSRF thiếu → 419, MFA enroll/confirm/verify, dùng lại mã, 429, mã khôi phục một lần, step-up hết hạn, phiên thu hồi, đặt lại mật khẩu (token một lần, hết hạn), IP allowlist, API token (sai, hết hạn, ngoài CIDR, thiếu scope, user portal/khóa) |
| RBAC | ma trận mọi endpoint × SA/AD_IN/AD_OUT/US_OWNER/US_OTHER (200/403/404), luôn còn một SA, giả danh (chỉ SA, lý do, chỉ USER đang hoạt động) |
| Job | thành công, lỗi tạm thời → retry, quá max_attempts, agent mất kết nối, lỗi không retry, hủy queued/running, timeout, idempotency (replay, key dùng lại cho request khác → 409) |
| Hosting | tạo (job → active, lỗi → failed → retry), máy trạng thái (bảng FROM, chuyển sai → 409), account bận → 409, terminate (quyền, step-up, xác nhận sai → 422), khôi phục trong hạn, quota 422, UID không tái dùng 90 ngày, đổi gói, chuyển phiên bản gói, 501 purge/migrate |
| Audit, thông báo, cài đặt, server | hash chain + phát hiện sửa, CSV chống chèn công thức, phạm vi ADMIN, thông báo của người khác 404, cài đặt ETag/412/step-up/không trả secret, server facts từ agent, AuditDenied ghi 403 |

## 7. Lỗi tìm thấy ở 3.6 và đã sửa

| Lỗi | Sửa |
|---|---|
| 21 test Playwright của shell (Design System, a11y) bị đưa về trang đăng nhập vì bản build thường giờ dùng phiên thật | fixture e2e giả lập `/auth/me` (người đã xác minh MFA theo realm) và trả 404 `not_available` cho API chưa giả lập |
| Test Pest "route không tồn tại" còn kỳ vọng `type` `not_found` | cập nhật theo hành vi mới của 3.6: `type` `…/errors/not_available`, `code` vẫn `not_found` (nằm trong enum contract) |
| Trang Thông báo: phần "Tùy chọn nhận" xoay mãi khi API chưa có (`notification-preferences` thuộc Phase 11) | hiện trạng thái lỗi / "Chưa có ở bản này" thay vì skeleton vô hạn |
| Loại job `hosting_account.reconcile` chưa có nhãn VI/EN | thêm vào `common.json` cả hai ngôn ngữ |
| Mọi lỗi 4xx có chủ đích (chưa đăng nhập, dữ liệu sai…) bị ghi `local.ERROR` kèm stack trace vào log Laravel | `dontReportWhen` cho `ApiProblem` có status < 500; lỗi 5xx vẫn ghi log |

## 8. Giới hạn, việc để Phase sau

- Agent là mock: account "Hoạt động" chỉ ở mức dữ liệu panel; tạo user Linux, quota thật là Phase 4.
- Purge (Phase 8) và chuyển server (Phase 9) trả 501. Website, database, backup, bảo mật, giám sát hiện "Chưa có ở bản này".
- `staticcheck` (Go) vẫn SKIP vì chưa cài được trong container (như Phase 1, 2).
- Coverage % chưa đo được (mục 6). Khi có máy dev cài pcov: `XDEBUG_MODE=coverage` hoặc `php -d extension=pcov.so vendor/bin/pest --coverage --min=80`.
- E2E stack thật không nằm trong `make check` vì cần `make dev` đang chạy; chạy bằng `make test-e2e-real`.

## 9. Bước tiếp theo

**DỪNG trước Phase 4**, chờ người dùng duyệt Phase 3 và các quyết định D-58 → D-62.
