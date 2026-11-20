# PHASE_STATUS — ITSO Panel

> File này là nguồn sự thật cho "đang ở đâu". Cập nhật sau MỖI task (commit cùng code).

## Hiện tại
- **Phase:** 1 — Foundation, Architecture, Database, API Contracts, Design System (đang làm)
- **Prompt hiện tại:** 1.1 ✓ hoàn tất, chờ duyệt
- **Task đang làm:** — (dừng chờ duyệt Prompt 1.1)
- **Commit cuối:** xem `git log -1` trên nhánh `phase-1` (commit cập nhật trạng thái 1.1)
- **Bước tiếp theo:** Người dùng duyệt 1.1 → Prompt 1.2 (Architecture & ADR)
- **Blocker:** Không có (GitHub không bắt buộc; Phase 1 khởi tạo Git local — D-51)

## Tổng quan Phase (phạm vi nội bộ, chốt 2026-11-20)
| Phase | Tên | Trạng thái |
|---|---|---|
| 0 | Planning | ✓ APPROVED |
| 1 | Foundation, Architecture, Database, API Contracts, Design System | ✱ |
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
Phase 1 (đang làm)
- ✓ 1.1 Git local, cấu trúc repo, file tiến độ, CLAUDE.md
- ○ 1.2 Architecture & ADR trong repo
- ○ 1.3 Database schema (DBML) + kiểm chứng trên PostgreSQL
- ○ 1.4 API Contracts (OpenAPI admin/portal, agent schemas, test vectors)
- ○ 1.5 Scaffold web/api/agent + mock agent + dev env
- ○ 1.6 Design System (tokens, Light/Dark, i18n, component nền, app shell 2 entry)
- ○ 1.7 CI, codegen, kiểm tra tổng và báo cáo Phase 1

## Nhật ký
| Thời điểm | Phase/Prompt | Việc | Commit |
|---|---|---|---|
| 2026-11-20 | 0 | Hoàn tất bộ tài liệu planning | — |
| 2026-11-20 | 0 | Điều chỉnh cho khách hàng bên ngoài (file 14, D-23…D-31, Phase 9 mới) | — |
| 2026-11-20 | 0 | Định hướng Hosting Provider (file 15, D-32…D-45, 15 Phase / 3 giai đoạn) | — |
| 2026-11-20 | 0 | Chốt phạm vi NỘI BỘ: billing/WooCommerce/storefront → OUT OF SCOPE, Provisioning API → DEFERRED; viết lại PROJECT_PLAN, ARCHITECTURE, ROADMAP, DATABASE, API, DECISIONS (D-46…D-50) | — |
| 2026-11-20 | 0 | Người dùng APPROVED kế hoạch (D-24, D-25, D-46…D-53); chuẩn bị prompt Phase 1 | — |
| 2026-11-20 | 1 / 1.1 | Git local, cấu trúc repo, CLAUDE.md, Makefile, check-structure; đưa kế hoạch vào repo | f7ccc70, ece3ec8 |
