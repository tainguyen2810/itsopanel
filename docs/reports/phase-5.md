# Báo cáo Phase 5: Website, Nginx, PHP-FPM, SSL, DNS

- **Trạng thái:** ✓ hoàn tất phần làm được không cần VM. Nhánh `phase-5`, merge `--no-ff` vào `main` ở Git local (không push, không remote). Tiêu chí cần máy Linux thật được đánh dấu **chờ VM**; bộ script đã sẵn sàng (`tests/vm/phase5.sh`).
- **Thời gian:** 2026-11-21.
- **Cách làm:** như Phase 4 ("Làm trước, VM test sau"). Code và test chạy với runner giả, agent `--sandbox` (ký HMAC, không chạy lệnh hệ thống) và stack cloud thật (PostgreSQL 16 + Redis + Laravel + Vite).
- **Phạm vi giữ đúng:** không đổi cấu hình máy chủ thật, không deploy. Laravel không chạy lệnh hệ thống (`check-no-exec` xanh; Cloudflare gọi bằng HTTP client). Agent không có op chạy lệnh tùy ý, không `sh -c`; vhost sinh từ template chỉ nhận giá trị đã validate. Billing/WooCommerce/thanh toán: OUT OF SCOPE.
- **Quyết định đề xuất chờ duyệt:** D-67 (vhost từ template, `nginx -t` + hoàn tác), D-68 (PHP-FPM master theo account, pool theo website), D-69 (ACME bằng lego trên agent, HTTP-01 webroot), D-70 (DNS Cloudflare từ Laravel). ADR 0014 → 0017 có mục "Sửa đổi khi hiện thực".

## 1. Đã làm

| Prompt | Kết quả chính | Commit |
|---|---|---|
| 5.1 Contracts | ADR 0014–0017, contracts op web (`fs.site_layout.ensure`, `nginx.vhost.apply/remove/inspect`, `nginx.global.apply`, `php.version.install/remove`, `php.pool.apply/remove`, `cert.issue/install/inspect/remove`, `log.tail`), OpenAPI Website/PHP/Nginx/SSL/DNS, migration | 2af9ee5 |
| 5.2 Agent | Vhost + `nginx -t` + hoàn tác, PHP-FPM theo account (unit `itso-php@<ver>-<user>`), lego ACME, log.tail; sandbox mô phỏng `nginx -t` lỗi và lego tự ký | f5b9549 |
| 5.3 API | Website, domain, PHP Manager, Nginx toàn server, tạm khóa áp lại vhost, wizard bước 4 (stack), quota theo gói | 4eb5856 |
| 5.4 SSL + DNS | ACME (cấp, gia hạn hằng ngày, thông báo khi lỗi), chứng chỉ tải lên (khóa mã hóa, job chỉ mang tham chiếu bí mật), agent reload Nginx khi thay chứng chỉ đang dùng; DNS Cloudflare (provider, zone, record qua bước panel, `itso:dns-sync`) | 36d69db |
| 5.5 UI | Lỗi job dễ hiểu theo mã (`nginx -t` → "đã hoàn tác" + dòng lỗi), quota theo gói, wizard stack, tải chứng chỉ riêng, quản lý provider/zone DNS, MSW theo contract | 0a1e58e |
| 5.6 Tích hợp | Playwright stack thật Phase 5; hộp thoại step-up MFA dùng chung (xóa website/provider trước đây không làm được trên UI); tên job Phase 5 thiếu i18n; `tests/vm/phase5.sh` + Pebble HTTP-01 thật; runbook | (commit 5.6) |

## 2. File chính

| Phần | Vị trí |
|---|---|
| Agent web | `agent/internal/ops/{web,php,cert,sandbox_web}.go`, `agent/internal/ops/templates/` |
| Panel | `apps/api/app/Domain/{Web,Dns}/`, `app/Infrastructure/Cloudflare/`, `app/Domain/Jobs/{PanelStep,Secrets}.php` |
| UI | `apps/web/src/shared/hosting/pages/WebsiteDetailPage.tsx`, `src/entries/admin/sites/{DnsPage,DnsManage}.tsx`, `src/entries/admin/install/`, `src/shared/auth/StepUpHost.tsx`, `src/shared/jobs/jobErrors.ts` |
| Test VM | `tests/vm/phase5.sh`, `tests/vm/pebble/` |
| E2E stack thật | `apps/web/e2e-real/phase5.spec.ts` |
| Vận hành | `docs/runbooks/phase-5-websites.md` |

## 3. Cách chạy thử

- Dev: `ITSO_ACME_EMAIL=ops@itso.local make dev`, seed `DemoSeeder`, rồi `make test-e2e-real`.
- Demo không cần backend: `make dev-demo` (MSW).
- VM: sau `run-all.sh --no-uninstall`, chạy `ITSO_PEBBLE_VM=1 bash tests/vm/pebble/start.sh` rồi `bash tests/vm/phase5.sh`.

## 4. Kết quả test

`make check` (2026-11-21, PostgreSQL 16 + Redis cục bộ, commit 218b00c): **22 PASS · 1 SKIP (staticcheck) · 0 FAIL**, git-clean PASS (632 s). Chi tiết ở `TEST_REPORT.md` (Prompt 5.5, 5.6).

| Bộ test | Kết quả |
|---|---|
| Pest (PostgreSQL 16 + Redis) | 369/369 |
| Go (race, 12 package) + fuzz | PASS (308 974 lần chạy fuzz) |
| Vitest | 486/486 |
| Playwright (demo MSW + Design System, gồm axe) | 261/261 |
| Playwright stack thật + agent sandbox (`make test-e2e-real`) | 8/8 |
| Installer · unit systemd | PASS |
| pint, phpstan, ESLint, Prettier, tsc, i18n (2590 khóa, vi = en), gofmt, go vet, no-exec, docs-check | xanh |

E2E stack thật (itso-agent sandbox):

1. Admin: cài PHP 8.3 qua PHP Manager → tạo website PHP cho `anphat` (job layout → pool → vhost) → Sẵn sàng → thêm alias `www.` → xin chứng chỉ (lego sandbox tự ký) → Hợp lệ → tạm khóa account, website chuyển `suspended` → mở khóa → xóa website (gõ domain, nhập lại TOTP) → không còn trong danh sách.
2. Portal: khách tự tạo website cho account của mình → Sẵn sàng.
3. Bốn luồng Phase 3 và hai luồng Phase 4 chạy lại: PASS.

**Lỗi tìm thấy nhờ e2e stack thật (đã sửa):** (1) API đòi step-up MFA khi xóa website/provider DNS nhưng UI không có hộp thoại xác thực lại, nên thao tác luôn lỗi 403. Đã thêm hộp thoại dùng chung: gặp `mfa_step_up_required` thì hỏi mã TOTP, gọi `/auth/step-up` rồi gửi lại đúng một lần. (2) Tên job Phase 5 (`website.domain.add`, `setup.stack`, `php.version.install`…) chưa có nhãn i18n, drawer hiện mã thô. (3) Khi viết `phase5.sh` (W5) phát hiện xóa website không gỡ chứng chỉ, để lại `/etc/itso/certs/<uuid>`: job `website.delete` nay thêm `cert.remove` cho mọi chứng chỉ của site sau `nginx.vhost.remove` / `php.pool.remove` và xóa bản ghi khi job xong (test Pest mới).

## 5. Tiêu chí nghiệm thu Phase 5 (11-ROADMAP)

| Tiêu chí | Kết quả | Bằng chứng / việc còn lại |
|---|---|---|
| Site PHP hiển thị phpinfo đúng uid account | ✓ (sandbox) · **chờ VM** | Golden pool `user=<account>`, master chạy uid account (test Go); e2e tạo site thật qua agent sandbox. VM: W1 đo `posix_geteuid()` của 20 site |
| HTTPS hợp lệ (Pebble / LE staging) | **chờ VM/CI** | Luồng cấp và cài chứng chỉ qua sandbox (e2e), test Pest ACME/tải lên. lego ↔ Pebble thật: job CI `pebble` và VM W4 (HTTP-01 thật qua Nginx) chưa chạy được: repo chưa có remote, container cloud không chạy được Pebble dưới root |
| Gia hạn chứng chỉ tự động | ✓ (logic) · **chờ VM** | `itso:certs-renew` hằng ngày, chọn đúng chứng chỉ < 30 ngày, lỗi → thông báo + audit (Pest). VM W4: Pebble cấp hạn 20 ngày, `renew` ra chứng chỉ mới |
| Xóa site không để lại cấu hình rác | ✓ (sandbox) · **chờ VM** | Test Go vhost/pool remove; Pest: xóa website gọi `nginx.vhost.remove` → `php.pool.remove` → `cert.remove` (sửa ở 5.6). VM W5 grep `/etc/nginx`, `/etc/itso/php`, `/etc/itso/certs`, `/etc/systemd/system` |
| 1 vhost lỗi không làm hỏng các site khác | ✓ (sandbox) · **chờ VM** | Agent `nginx -t` lỗi → khôi phục file cũ, không reload (test Go); UI giải thích lỗi. VM W3: cấu hình hỏng → `config_test_failed`, 20 site vẫn 200 |

## 6. Còn lại / rủi ro

- **Chạy bộ test VM** Phase 4 + Phase 5 và dán kết quả vào mục 5 (cần VM Ubuntu 24.04 có Docker cho Pebble).
- **Job CI `pebble`** chờ có remote GitHub.
- PHP chỉ 8.3 từ kho Ubuntu (D-68); phiên bản khác trả 409.
- DNS chỉ Cloudflare; Portal chưa quản lý DNS (đúng sitemap).
- Portal xóa website cũng cần step-up nên khách phải bật MFA trước khi xóa. Có thể nới lỏng nếu muốn (quyết định của người dùng).
- `shellcheck`, `staticcheck`, coverage % vẫn không có trên container.

## 7. Bước tiếp theo

Chờ duyệt Phase 5 và D-67 → D-70. **Không** bắt đầu Phase 6 khi chưa được duyệt.
