# PHASE_STATUS — ITSO Panel

> File này là nguồn sự thật cho "đang ở đâu". Cập nhật sau MỖI task (commit cùng code).

## Hiện tại

- **Phase:** 3 — Auth, RBAC, Users, Packages, Accounts, Jobs, Audit (đang làm; Phase 2 ✓ hoàn tất và merge 2026-11-20, chờ duyệt cùng D-56/D-57)
- **Prompt hiện tại:** 3.5 Gói, Hosting Provisioning Service, tài khoản, API Portal. Người dùng yêu cầu (2026-11-20) lên kế hoạch và thực hiện Phase 3; làm hàng loạt 3.1 → 3.6, tự merge local
- **Task đang làm:** 3.5 — bắt đầu (3.4 ✓)
- **Commit cuối:** xem `git log -1` trên nhánh `phase-3`
- **Bước tiếp theo:** Theo `docs/planning/seed/PHASE_3_PROMPTS.md`; cuối 3.6 báo cáo Phase 3 và DỪNG (không bắt đầu Phase 4)
- **Blocker:** Không có (GitHub không bắt buộc; Phase 1 khởi tạo Git local — D-51)

## Tổng quan Phase (phạm vi nội bộ, chốt 2026-11-20)

| Phase | Tên | Trạng thái |
|---|---|---|
| 0 | Planning | ✓ APPROVED |
| 1 | Foundation, Architecture, Database, API Contracts, Design System | ✓ APPROVED |
| 2 | Complete UI Demo (Admin Panel + User Hosting Portal) | ✓ (báo cáo `docs/reports/phase-2.md`) |
| 3 | Auth, RBAC, Users, Packages, Accounts, Jobs, Audit | ✱ |
| 4 | Go Agent, Installer, CLI, cách ly và quota | ○ |
| 5 | Website / Nginx / PHP / SSL / DNS | ○ |
| 6 | Database / File / FTP-SFTP / Cron / Terminal | ○ |
| 7 | Security Center | ○ |
| 8 | Backup & Restore → v0.1.0-alpha | ○ |
| 9 | Multi-server & chuyển tài khoản | ○ |
| 10 | Docker Manager, WordPress Toolkit, Software | ○ |
| 11 | Monitoring, Alerts, Notifications → v0.5.0-beta | ○ |
| 12 | Production Hardening & Production Gate → v1.0.0 | ○ |

## Checklist Phase hiện tại

Phase 3 (đang làm) — prompt chi tiết: `docs/planning/seed/PHASE_3_PROMPTS.md`

- ✓ 3.1 Schema Phase 3 (migrations), model, Pest trên PostgreSQL
- ✓ 3.2 Auth theo realm, MFA, phiên, mật khẩu, API token
- ✓ 3.3 RBAC, phạm vi ADMIN, Policies, Users API
- ✓ 3.4 Jobs, mock agent, idempotency, audit, thông báo, cài đặt
- ✱ 3.5 Gói, Hosting Provisioning Service, tài khoản, API Portal
- ○ 3.6 Nối UI vào API thật, e2e, báo cáo Phase 3

Phase 2: ✓ hoàn tất 2026-11-20 (báo cáo `docs/reports/phase-2.md`, merge `6a9cda5`, tag `v0.0.1-demo`).

Phase 1: ✓ APPROVED 2026-11-20 (báo cáo `docs/reports/phase-1.md`).

## Nhật ký

| Thời điểm | Phase/Prompt | Việc | Commit |
|---|---|---|---|
| 2026-11-20 | 0 | Hoàn tất bộ tài liệu planning | — |
| 2026-11-20 | 0 | Điều chỉnh cho khách hàng bên ngoài (file 14, D-23…D-31, Phase 9 mới) | — |
| 2026-11-20 | 0 | Định hướng Hosting Provider (file 15, D-32…D-45, 15 Phase / 3 giai đoạn) | — |
| 2026-11-20 | 0 | Chốt phạm vi NỘI BỘ: billing/WooCommerce/storefront → OUT OF SCOPE, Provisioning API → DEFERRED; viết lại PROJECT_PLAN, ARCHITECTURE, ROADMAP, DATABASE, API, DECISIONS (D-46…D-50) | — |
| 2026-11-20 | 0 | Người dùng APPROVED kế hoạch (D-24, D-25, D-46…D-53); chuẩn bị prompt Phase 1 | — |
| 2026-11-20 | 1 / 1.1 | Git local, cấu trúc repo, CLAUDE.md, Makefile, check-structure; đưa kế hoạch vào repo | f7ccc70, ece3ec8 |
| 2026-11-20 | 1 / 1.2 | ARCHITECTURE.md (6 sơ đồ Mermaid), 10 ADR, threat model, sitemap UI; scripts docs-check | b6ac081 |
| 2026-11-20 | 1 / 1.3 | DBML 78 bảng, itso.sql + extras.sql (trigger realm, purge guard D-46, audit append-only + hash chain, partition), ERD 9 SVG, ownership/lifecycle/migration-plan, db-verify 41 test | 1de27fe |
| 2026-11-20 | 1 / 1.4 | OpenAPI admin 208 + portal 90 operation (+ common), agent-ops 60 op có schema + 21 khai báo, evil-inputs 93 vector, demo dataset, Redocly ruleset + check_contracts + ajv | 6a06302 |
| 2026-11-20 | 1 / mockup | Mockup dashboard Admin (desktop/tablet/mobile) trước 1.5 theo yêu cầu | 7aefaf0 |
| 2026-11-20 | 1 / 1.5 | Contract `GET /admin/system/status` + op `system.ping`; apps/web (Vite/React/Tailwind, 2 entry), apps/api (Laravel 13.43, RFC 9457, Pest, Larastan + rule cấm exec), agent mock (Go, unix socket), make setup/dev/test/lint, compose dev, runbook | 67211b5, e050c8c, 53f4a13, 16837e7, 1fd5485 |
| 2026-11-20 | 1 / 1.6 | Token Light/Dark + sinh CSS/@theme + kiểm AA 84/84; lint cấm màu cứng; ThemeProvider + chặn nháy; i18n VI/EN; 25 component; AdminShell/PortalShell; trang /design (dev); Vitest 26, Playwright 30 (14 ảnh, axe 0 lỗi nghiêm trọng); design/docs | 6e48570, 18f5ea6, 50087c3 |
| 2026-11-20 | 1 / 1.7 | Codegen TS (openapi-typescript + openapi-fetch) và Go structs (generator Python), codegen-check; CI 7 job; `make check` 21 bước (20 PASS, 1 SKIP); runbook GitHub; báo cáo Phase 1; clean clone xanh; merge `phase-1 → main` (local) | cde2c40, f1d6205, 62c12f2 + commit này |
| 2026-11-20 | 1 → 2 | Người dùng duyệt Phase 1 ("Tiếp nhé"); D-54, D-55 APPROVED; viết PHASE_2_PROMPTS.md, mở nhánh `phase-2` | — |
| 2026-11-20 | 2 / 2.1 | Dataset mở rộng + check_demo.py; MSW theo OpenAPI (dispatcher theo template, job giả lập theo thời gian, phạm vi vai trò); contract list khai báo 422; TanStack Router theo sitemap (58 admin + 18 portal), guard 403, breadcrumb, khung trang (PageHeader, ListPage URL state, DetailPage tabs URL, FormDialog, trạng thái), drawer job; `dev:demo`/`build:demo`; Vitest 110, Playwright 106 | 87c2fe0 + commit này |
| 2026-11-20 | 2 / 2.2 | Contract thêm `jobs/{id}:retry` (admin + portal, theo 05-API); API giả lập ghi (auth/MFA/step-up/đổi mật khẩu/phiên, hủy/thử lại job sinh audit) và dashboard tính từ dữ liệu theo phạm vi vai trò; Dashboard theo mockup, Jobs + chi tiết, Hồ sơ (mật khẩu, MFA, phiên), Ctrl+K tìm thật, Đăng nhập/MFA, wizard cài đặt 10 bước; namespace i18n `admin` (575 key); Vitest 141, Playwright 112 | 2b71414 |
| 2026-11-20 | 2 / 2.3 | Contract: `ComposeProject.compose_yaml`; API giả lập hạ tầng (token thêm server + agent giả lập kết nối, sửa/reboot, dịch vụ, phần mềm/PHP, Nginx, tường lửa safe-apply có tự hoàn tác, Docker, Compose, Registry, terminal ticket) với dữ liệu tách theo từng server; 12 trang: danh sách/thêm/chi tiết server (5 tab), Nginx, PHP, phần mềm, tường lửa (đếm ngược xác nhận), Docker, terminal mô phỏng có chính sách, Compose (+chi tiết, sửa YAML), Registry; Vitest 188, Playwright 116 | 63b40ab |
| 2026-11-20 | 2 / 2.4 | Dataset: thêm Super Admin thứ hai (Nguyễn Hải) cho purge 2 bước; API giả lập gói và tài khoản hosting (tạo/sửa gói tạo phiên bản bất biến D-43, chuyển account lên phiên bản mới, tạo account qua job, khóa/mở khóa, đổi gói, chấm dứt, purge 2 SA D-46 + legal hold, chuyển server preflight → sync → verify → cutover/rollback), gợi ý đặt account tính theo tài nguyên và phạm vi; 8 trang: gói (danh sách, thêm, chi tiết + lịch sử phiên bản + so sánh), tài khoản (danh sách, wizard tạo, chi tiết 7 tab, wizard chuyển server, đã chấm dứt); Stepper dùng chung; Vitest 233, Playwright 120 | be4a5a0 |
| 2026-11-20 | 2 / 2.5 | Contract + DB: Git deploy (bảng `git_repositories`, `git_deployments`; 9 endpoint admin/portal; op `git.deploy`, `git.rollback`; D-56 ĐỀ XUẤT), dataset thêm 2 zone DNS; thư viện dùng chung đường dẫn File Manager / cron / record DNS; API giả lập Hosting II (website + domain/SSL/Nginx/PHP/WAF/log, DB + user + quyền, File Manager ảo trong home có etag, SFTP/SSH key, DNS, cron theo giới hạn gói, WordPress, Git deploy/rollback); 10 trang: website (+chi tiết 8 tab), database, File Manager 2 khung, SFTP/SSH, SSL, DNS, cron (+lịch sử), WordPress, Git deploy; ListPage nhúng hiện mô tả + nút; Vitest 326, Playwright 124 | 01e004e, b067733, 3887735 |
| 2026-11-20 | 2 / 2.6 | Dataset thêm quy tắc/cảnh báo/uptime/quét mã độc, chính sách sao lưu cấu hình panel, lần khôi phục lỗi; API giả lập quản trị (`handlers/governance.ts`: SSH/fail2ban có If-Match, allowlist chặn rỗng/CIDR sai/xung đột, quarantine; đích sao lưu không hạ Object Lock và không lưu bí mật, chính sách, snapshot khóa bất biến, duyệt cây, kiểm chứng, khôi phục ghi đè phải gõ username; người dùng tạo/sửa/phạm vi ADMIN/khóa/MFA/impersonate có lý do vào audit; quy tắc cảnh báo; xuất audit CSV; thông báo; cài đặt chỉ SA); 18 trang: Bảo mật (tổng quan + WAF, mã độc, SSH, fail2ban, FIM, IP được phép), Sao lưu (checklist 3-2-1-1-0, lịch sử, chính sách, đích, kiểm chứng), Khôi phục (+ wizard 4 bước), Người dùng (+ chi tiết, phạm vi), Vai trò (ma trận chỉ xem), Giám sát (+ cảnh báo), Nhật ký kiểm toán (lọc, chi tiết, CSV chống chèn công thức), Thông báo, Cài đặt 5 tab; Vitest 383, Playwright 127 | 715bebf, 957f0f8 |
| 2026-11-20 | 2 / 2.7 | User Hosting Portal: contract `GET /hosting-accounts/{id}/features` (D-57 ĐỀ XUẤT, admin + portal); lớp API trung lập realm (`shared/api/realm.ts`, đường dẫn không tiền tố, kiểu theo contract Portal) nên trang hosting/website/database/file/SFTP/cron/WordPress/sao lưu/khôi phục/đăng nhập/hồ sơ/job/thông báo dùng chung `shared/`, phần chỉ Admin cắm qua slot; API giả lập Portal (`handlers/portal.ts`) chỉ trả dữ liệu account user sở hữu, job/thông báo theo user, terminal theo gói có SSH; 18 route Portal (Tổng quan usage/quota, chi tiết gói, tạo website, sao lưu 3 tab, terminal, quên mật khẩu); sửa đổi user demo không tải lại dữ liệu đang hiện, chuông thông báo đếm từ dữ liệu thật; Vitest 452, Playwright 129 | 3ab0fe1 |
| 2026-11-20 | 2 / 2.8 | Kiểm tra tổng: 74 route axe light/dark + 390px + EN không lẫn tiếng Việt; số liệu nhất quán (5 test); 56 ảnh trang chính `docs/screenshots/phase-2/`; bản demo tĩnh; `make check` (2 bước đỏ lần đầu do môi trường/markdown, sửa và chạy lại PASS); sửa 5 lỗi a11y; báo cáo `docs/reports/phase-2.md` | b7f6bd9 |
| 2026-11-20 | 3 / 3.1 | Migration Phase 3 sinh từ đặc tả (`database/tools/gen_migrations.py`, `make db-migrations`): 26 bảng + trigger/CHECK của extras.sql; `db-verify` kiểm file khớp đặc tả và Phase 3 → 11 áp lần lượt = itso.sql + extras.sql; 22 model Eloquent (uuid công khai, cast `text[]`), factory, RoleSeeder, hash argon2id; Pest chạy trên PostgreSQL 16 (D-59), CI/Makefile/compose cập nhật; 9 test schema | 3afe712 |
| 2026-11-20 | 3 / 3.2 | Xác thực (D-58): contract thêm header `X-ITSO-Realm` + cookie phiên theo realm; middleware realm → cookie `itso_{realm}_session` (chạy trước StartSession), phiên bảng `sessions` có realm + `mfa_verified_at`, CSRF cookie `XSRF-TOKEN-{REALM}` → 419; login argon2id, cùng lỗi cho sai realm/khóa, khóa lũy tiến email + IP (`login_attempts`); TOTP RFC 6238 tự viết + 10 mã khôi phục argon2id, SA bắt buộc MFA, step-up 10 phút; phiên của tôi (uuid băm), đổi/quên/đặt lại mật khẩu (token SHA-256 trong cache, một lần, 60 phút, mail log); IP allowlist realm admin/api; guard API token SHA-256 + scope + CIDR; route admin/system chuyển sau đăng nhập admin. Pest 65 (42 mới) | 7a6b371 |
| 2026-11-20 | 3 / 3.3 | RBAC: danh mục quyền + `PermissionSeeder` (SA `*`, ADMIN theo nhóm, USER `own.*`), `Access` (phạm vi ADMIN qua `user_scopes`, ngoài phạm vi 404), middleware `itso.perm` (kèm scope token); Users API (list lọc/tìm/cursor, tạo + mời, sửa có ETag/If-Match, khóa/mở, reset MFA có step-up, scopes GET/PUT), roles, API token CRUD (uuid HMAC, secret một lần); giả danh bằng vé một lần (contract `impersonation:accept`/`end`, D-61 đề xuất); luôn còn ≥1 SUPER_ADMIN; `AuditLogger` tối thiểu (che secret, hash chain DB). Ma trận quyền 68 ô + 13 test API; Pest 146 | 4406e7e |
| 2026-11-20 | 3 / 3.4 | JobRunner (D-60): `JobDispatcher` → queue Redis → bước op agent có kiểu, `op_id = job_uuid:seq:attempt`, retry có backoff cho lỗi tạm thời, cancel, timeout, job_logs, thông báo khi lỗi; mock agent thêm op `account.*`/`quota.*` (kho trong bộ nhớ, struct sinh); `/jobs` admin + portal (list, chi tiết ETag, logs, events snapshot SSE, cancel, retry); middleware `itso.idempotent` (cùng key khác request → 409 theo contract); `/audit-logs` lọc + xuất CSV chống chèn công thức, `itso:audit-verify`, audit `denied` cho 403; thông báo in-app; `/settings/{group}` (SA, secret mã hóa, step-up, ETag); `/servers` + server local từ cấu hình (`itso:server-local` đọc `system.info`); `/dashboard/summary`. Pest 206 (60 mới) | (commit 3.4) |
