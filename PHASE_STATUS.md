# PHASE_STATUS — ITSO Panel

> File này là nguồn sự thật cho "đang ở đâu". Cập nhật sau MỖI task (commit cùng code).

## Hiện tại

- **Phase:** 1 — Foundation, Architecture, Database, API Contracts, Design System — **✓ hoàn tất, chờ duyệt**
- **Prompt hiện tại:** 1.7 ✓ (Phase 1 xong; đã merge `phase-1` vào `main` ở Git local)
- **Task đang làm:** — (DỪNG chờ duyệt Phase 1; không bắt đầu Phase 2)
- **Commit cuối:** xem `git log -1` trên nhánh `phase-1` (merge commit `phase-1 → main`)
- **Bước tiếp theo:** Người dùng duyệt Phase 1 (báo cáo `docs/reports/phase-1.md`, quyết định đề xuất D-54, D-55) → Phase 2 (Complete UI Demo) khi có lệnh
- **Blocker:** Không có (GitHub không bắt buộc; Phase 1 khởi tạo Git local — D-51)

## Tổng quan Phase (phạm vi nội bộ, chốt 2026-11-20)

| Phase | Tên | Trạng thái |
|---|---|---|
| 0 | Planning | ✓ APPROVED |
| 1 | Foundation, Architecture, Database, API Contracts, Design System | ✓ chờ duyệt |
| 2 | Complete UI Demo (Admin Panel + User Hosting Portal) | ○ |
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

Phase 1 (✓ hoàn tất, chờ duyệt)

- ✓ 1.1 Git local, cấu trúc repo, file tiến độ, CLAUDE.md
- ✓ 1.2 Architecture & ADR trong repo
- ✓ 1.3 Database schema (DBML) + kiểm chứng trên PostgreSQL
- ✓ 1.4 API Contracts (OpenAPI admin/portal, agent schemas, test vectors)
- ✓ 1.5 Scaffold web/api/agent + mock agent + dev env
- ✓ 1.6 Design System (tokens, Light/Dark, i18n, component nền, app shell 2 entry)
- ✓ 1.7 CI, codegen, kiểm tra tổng và báo cáo Phase 1

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
