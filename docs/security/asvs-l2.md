# OWASP ASVS 4.0.3 Level 2: checklist ITSO Panel (Prompt 12.4)

Rà ngày 2026-11-23 trên nhánh `phase-12`. Phạm vi: Admin Panel, User Portal, Laravel API, Go agent, gateway terminal, installer.
Trạng thái: **✓ đạt** (có bằng chứng), **◐ đạt một phần** (ghi phần còn lại + kế hoạch), **— không áp dụng** (lý do).
Bằng chứng là test chạy được hoặc file trong repo; mục cần VM ghi "chờ VM" (Gate 12.8).

Kết luận: **không còn mục High/Critical mở.** Bốn mục thiếu tìm ra khi rà đã sửa trong 12.4 (đánh dấu **[12.4]**). Mục ◐ là
Medium/Low, có kế hoạch, không chặn `v1.0.0-rc.1`. Pentest độc lập trước khi mở cho khách ngoài (D-50).

## Mục sửa trong 12.4

| # | Thiếu | Sửa | Bằng chứng |
|---|---|---|---|
| 1 | Cookie phiên không có cờ `Secure` khi installer không đặt `SESSION_SECURE_COOKIE` (V3.4.1) | `config/session.php`: mặc định `Secure` khi `APP_ENV=production` | `tests/Feature/Phase12/HardeningTest.php` (cookie Secure) |
| 2 | Header bảo mật chỉ có ở Caddy; chạy sau proxy khác thì mất (V14.4) | Middleware `SecurityHeaders` (nosniff, `X-Frame-Options: DENY`, `Referrer-Policy`, CSP cho JSON, `Cache-Control: no-store` cho JSON); Caddy thêm `X-Frame-Options`, `Permissions-Policy`, COOP, `object-src 'none'` | `HardeningTest.php` (header) · `packaging/Caddyfile` |
| 3 | Không giới hạn kích thước body ở tầng ứng dụng (V12.1.1, V13.1) | Middleware `LimitRequestBody` (JSON ≤ 2 MB `ITSO_MAX_BODY_KB`, chunk upload ≤ 9 MB) → 413 `payload_too_large`; Caddy `request_body max_size 10MB` | `HardeningTest.php` (413) |
| 4 | Không có kiểm tự động route mới thiếu quyền / lộ tài nguyên ngoài phạm vi (V4.1.3, V4.2.1) | Test ma trận quyền sinh từ danh sách route: mọi route ghi admin phải có `itso.perm` (ngoại lệ có lý do), mọi route có `{id}` gọi bằng actor ngoài phạm vi với id thật chỉ được 403/404 | `tests/Feature/Phase12/RouteMatrixTest.php` (≥ 250 route) |

## V1 Kiến trúc, thiết kế, mô hình mối đe dọa

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 1.1.2 Mô hình mối đe dọa | ✓ | `docs/security/threat-model.md`, review theo Phase (`docs/security/*-review.md`) |
| 1.2.x Tách đặc quyền giữa thành phần | ✓ | Laravel không chạy lệnh hệ thống (`make no-exec`); agent typed op (`contracts/agent-ops`), socket peercred + HMAC (ADR 0006) · ADR 0056 |
| 1.4.x Kiểm soát truy cập tập trung | ✓ | `RequirePermission` + `Access::servers/accounts` · `RouteMatrixTest.php` · `Rbac/MatrixTest.php` |
| 1.5.x Validate ở tầng tin cậy | ✓ | Agent validate lại mọi tham số theo JSON Schema (`internal/validate`), vector độc `contracts/test-vectors` (362) |
| 1.6.x Quản lý khóa | ✓ | `APP_KEY`, khóa agent, khóa ký release (ADR 0019), khóa age backup (D-46) — `docs/runbooks/` |
| 1.14.x Cấu hình build/triển khai | ✓ | `make release` ký Ed25519; unit systemd siết (`make units-check`, exposure agent 4.9 ≤ 5.0) |

## V2 Xác thực

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 2.1.1 Mật khẩu ≥ 12 ký tự | ✓ | `PasswordController` `min:12` · `SessionPasswordTest.php` |
| 2.1.7 Kiểm mật khẩu bị lộ | ◐ | Không gọi dịch vụ ngoài (nội bộ, không gửi dữ liệu ra ngoài). Kế hoạch v1.x: danh sách mật khẩu phổ biến offline |
| 2.2.1 Chống dò mật khẩu | ✓ | Khóa lũy tiến theo tài khoản + IP, CAPTCHA portal, fail2ban jail panel · `LoginTest.php`, `AuthProtectionTest.php` |
| 2.2.3 Thông báo khi đổi thông tin xác thực | ✓ | Mail đặt lại mật khẩu, audit `user.password_change` · `SessionPasswordTest.php` |
| 2.4.1 Băm mật khẩu | ✓ | `argon2id` (`config/hashing.php`) |
| 2.5.x Khôi phục tài khoản | ✓ | Token một lần, hết hạn 60 phút, luôn 204 · `SessionPasswordTest.php` |
| 2.7/2.8 MFA (TOTP) | ✓ | TOTP bắt buộc cho realm admin, mã khôi phục một lần, chống dùng lại mã, step-up 10 phút cho thao tác nhạy cảm · `MfaTest.php` |
| 2.10 Bí mật dịch vụ | ✓ | Mật khẩu DB/SFTP/registry mã hóa (`Crypt`), chỉ đi vào job qua `Secrets::ref` · `p8leak` trong Pest Phase 6–12 |

## V3 Quản lý phiên

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 3.2.1 Phiên mới khi đăng nhập | ✓ | `SessionGuard::login` migrate session; MFA verify `migrate(true)` |
| 3.3.1 Đăng xuất hủy phiên | ✓ | `LoginTest.php` (logout → me 401) |
| 3.3.3 Thu hồi phiên khác khi đổi mật khẩu | ✓ | `PasswordController::change` + `SessionPasswordTest.php` |
| 3.3.4 Xem/thu hồi phiên | ✓ | `/auth/sessions` · `SessionPasswordTest.php` |
| 3.4.1 Cookie Secure | ✓ **[12.4]** | `HardeningTest.php` |
| 3.4.2 HttpOnly · 3.4.3 SameSite | ✓ | `config/session.php` (`http_only`, `lax`), cookie theo realm |
| 3.5.x Token API | ✓ | Token băm SHA-256, scope, CIDR, hết hạn · `AccessTest.php` |
| 3.7.1 Xác thực lại thao tác nhạy cảm | ✓ | `itso.step-up` (xóa account, terminal, import, khôi phục ghi đè…) · `MfaTest.php`, `ImportTest.php` |

## V4 Kiểm soát truy cập

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 4.1.1 Kiểm ở server | ✓ | Middleware `itso.perm` + scope trong controller |
| 4.1.3 Đặc quyền tối thiểu | ✓ **[12.4]** | `RouteMatrixTest.php` (route ghi thiếu quyền → đỏ) |
| 4.2.1 IDOR | ✓ **[12.4]** | `RouteMatrixTest.php` (id thật, actor ngoài phạm vi → 403/404) · `Rbac/MatrixTest.php` |
| 4.2.2 CSRF | ✓ | Double-submit `X-XSRF-TOKEN` · `LoginTest.php` |
| 4.3.1 MFA cho giao diện quản trị | ✓ | Realm admin bắt TOTP · `MfaTest.php` |
| 4.3.2 Không lộ thư mục/metadata | ✓ | Caddy chặn `/api/v1/internal/*`, không directory listing |
| 4.3.3 Giới hạn IP admin | ✓ | IP allowlist realm admin · `AccessTest.php` |

## V5 Validate, làm sạch, mã hóa đầu ra

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 5.1.x Validate theo schema | ✓ | Request validate Laravel + OpenAPI contract test (`assertMatchesContract`); agent JSON Schema |
| 5.2.x Làm sạch | ✓ | Vhost/cron/compose sinh bằng template + validator (ADR 0024, D-97) · fuzz `make test-fuzz` |
| 5.3.x Mã hóa đầu ra / XSS | ✓ | React escape mặc định, không `dangerouslySetInnerHTML` (ESLint) |
| 5.3.4 SQL injection | ✓ | Eloquent/bound params; `DB::raw` chỉ hằng số |
| 5.3.8 Command injection | ✓ | Không có exec trong Laravel; agent không `sh -c` (`make no-exec`) |
| 5.5.x Deserialization | ✓ | Chỉ JSON; không `unserialize` dữ liệu người dùng |

## V6 Mật mã khi lưu

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 6.2.x Thuật toán | ✓ | AES-256-CBC + HMAC (Laravel `Crypt`), Ed25519 ký release, age cho backup |
| 6.4.x Quản lý bí mật | ✓ | `/etc/itso` 0640, không commit secret; `Secrets::ref` |

## V7 Lỗi và log

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 7.1.1 Không log bí mật | ✓ | `p8leak` (job_steps, job_logs, audit_logs) · `ImportTest.php` |
| 7.2.x Log sự kiện bảo mật | ✓ | `audit_logs` (đăng nhập, quyền, thao tác), auth.log cho fail2ban · `AuthProtectionTest.php` |
| 7.3.x Bảo vệ log | ◐ | Audit chỉ ghi thêm ở tầng ứng dụng; chuyển log ra máy khác là việc v1.x (ghi trong sổ tay vận hành) |
| 7.4.1 Lỗi không lộ chi tiết | ✓ | RFC 9457, `APP_DEBUG=false` do installer đặt |

## V8 Bảo vệ dữ liệu

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 8.1.1 Không cache dữ liệu nhạy cảm | ✓ **[12.4]** | `Cache-Control: no-store` cho JSON · `HardeningTest.php` |
| 8.2.x Dữ liệu phía client | ✓ | SPA không lưu token/mật khẩu trong localStorage (phiên cookie) |
| 8.3.x Dữ liệu cá nhân | ✓ | Thông báo không chứa bí mật (D-105); export audit theo quyền |

## V9 Giao tiếp

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 9.1.x TLS | ✓ | Caddy TLS + HSTS; agent node mTLS (ADR 0035) |
| 9.2.x Kết nối ra ngoài | ✓ | Webhook qua SSRF guard (D-104) · `WebhookTransportTest.php` |

## V10 Mã độc / toàn vẹn

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 10.3.x Toàn vẹn cập nhật | ✓ | Release ký Ed25519, kiểm trước khi giải nén; journal cập nhật + `itso repair` (D-113) |
| 10.2.x Không có backdoor | ✓ | Không có op "chạy lệnh tùy ý"; review Phase 4–12 |

## V11 Logic nghiệp vụ

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 11.1.x Thứ tự bước, giới hạn | ✓ | State machine job/account/import (409 khi sai trạng thái), Idempotency-Key, giới hạn tần suất |

## V12 File và tài nguyên

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 12.1.1 Giới hạn kích thước | ✓ **[12.4]** | `LimitRequestBody` + Caddy · upload chunk 8 MB, quota account |
| 12.3.x Đường dẫn | ✓ | `fsx` openat O_NOFOLLOW, helper UID account, vector độc traversal |
| 12.4.x Lưu file ngoài webroot | ✓ | Staging upload ngoài webroot, giải nén có giới hạn (D-72) |
| 12.6.1 SSRF | ✓ | SSRF guard webhook, ACME chỉ thư mục cố định |

## V13 API

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 13.1.x Cấu hình API | ✓ **[12.4]** | Body tối đa, content-type JSON, CSRF cho phiên cookie |
| 13.2.x REST | ✓ | OpenAPI là hợp đồng (`make contracts-check`), method đúng ngữ nghĩa, 405 cho method sai |

## V14 Cấu hình

| Mục | Trạng thái | Bằng chứng |
|---|---|---|
| 14.1.x Build | ✓ | `make check`, `make release` tái lập |
| 14.2.x Phụ thuộc | ◐ | `composer audit`/`npm audit` chạy tay mỗi release; tự động hóa + SBOM trong `docs/security/update-policy.md` (12.6) |
| 14.3.x Không lộ thông tin | ✓ | `-Server` ở Caddy, xóa `X-Powered-By`, `APP_DEBUG=false` |
| 14.4.x Header bảo mật | ✓ **[12.4]** | `SecurityHeaders` + Caddy · `HardeningTest.php` |
| 14.5.x Kiểm Host/Origin | ✓ | Realm theo host (`LoginTest.php`), CORS không mở |

## Ngoài ASVS: hạ tầng (CIS, systemd)

- CIS Ubuntu 24.04 L1 chỉ đọc (D-109): `GET /security/cis`, `POST /security/cis:audit`; điểm CIS là mục `cis_l1` trong điểm bảo mật · `HardeningTest.php`.
- Unit `itso-agent.service` / `itso-agent-node.service`: `systemd-analyze security --offline` = **4.9** (trước 12.4: 6.1), kiểm trong `make units-check` · ADR 0056. Chạy thật trên VM: chờ VM.
