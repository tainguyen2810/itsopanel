# PHASE_STATUS — ITSO Panel

> File này là nguồn sự thật cho "đang ở đâu". Cập nhật sau MỖI task (commit cùng code).

## Hiện tại

- **Phase:** 2 — Complete UI Demo (đang làm; Phase 1 ✓ APPROVED 2026-11-20)
- **Prompt hiện tại:** 2.5 Hosting II (website, DB, file, SFTP, SSL, DNS, cron, WordPress, Git). Chạy hàng loạt 2.1 → 2.8, tự merge local cuối Phase
- **Task đang làm:** 2.5 — contract Git deployments, trang website
- **Commit cuối:** xem `git log -1` trên nhánh `phase-2`
- **Bước tiếp theo:** Theo `docs/planning/seed/PHASE_2_PROMPTS.md`; cuối 2.8 báo cáo Phase 2 và DỪNG (không bắt đầu Phase 3)
- **Blocker:** Không có (GitHub không bắt buộc; Phase 1 khởi tạo Git local — D-51)

## Tổng quan Phase (phạm vi nội bộ, chốt 2026-11-20)

| Phase | Tên | Trạng thái |
|---|---|---|
| 0 | Planning | ✓ APPROVED |
| 1 | Foundation, Architecture, Database, API Contracts, Design System | ✓ APPROVED |
| 2 | Complete UI Demo (Admin Panel + User Hosting Portal) | ✱ |
| 3 | Auth, RBAC, Users, Packages, Accounts, Jobs, Audit | ○ |
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

Phase 2 (đang làm) — prompt chi tiết: `docs/planning/seed/PHASE_2_PROMPTS.md`

- ✓ 2.1 Nền demo: router, MSW theo OpenAPI, dataset mở rộng, role switcher, khung trang, smoke test
- ✓ 2.2 Admin chung: Dashboard, Jobs, Profile, Ctrl+K, Login/MFA, wizard cài đặt
- ✓ 2.3 Hạ tầng: Servers, dịch vụ, Docker, Compose
- ✓ 2.4 Hosting I: gói, tài khoản hosting
- ✱ 2.5 Hosting II: website, DB, file, SFTP, SSL, DNS, cron, WordPress, Git
- ○ 2.6 Bảo mật, sao lưu, quản trị
- ○ 2.7 User Hosting Portal
- ○ 2.8 Kiểm tra tổng, báo cáo Phase 2

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
| 2026-11-20 | 2 / 2.4 | Dataset: thêm Super Admin thứ hai (Nguyễn Hải) cho purge 2 bước; API giả lập gói và tài khoản hosting (tạo/sửa gói tạo phiên bản bất biến D-43, chuyển account lên phiên bản mới, tạo account qua job, khóa/mở khóa, đổi gói, chấm dứt, purge 2 SA D-46 + legal hold, chuyển server preflight → sync → verify → cutover/rollback), gợi ý đặt account tính theo tài nguyên và phạm vi; 8 trang: gói (danh sách, thêm, chi tiết + lịch sử phiên bản + so sánh), tài khoản (danh sách, wizard tạo, chi tiết 7 tab, wizard chuyển server, đã chấm dứt); Stepper dùng chung; Vitest 233, Playwright 120 | commit này |
