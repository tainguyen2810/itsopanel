# ITSO Panel — Bộ tài liệu kế hoạch

> **Kế hoạch APPROVED 2026-11-20. Phạm vi: hệ thống quản trị máy chủ và Hosting dùng NỘI BỘ.** Chưa có code, chưa cài đặt hay deploy gì.

## Bản hiện hành (đọc trước), sẽ đặt ở gốc repository
| File | Nội dung |
|---|---|
| [seed/PROJECT_PLAN.md](seed/PROJECT_PLAN.md) | Định vị, chức năng trong phạm vi và ngoài phạm vi, nguyên tắc, lộ trình |
| [seed/ARCHITECTURE.md](seed/ARCHITECTURE.md) | Kiến trúc nội bộ: Admin Panel + User Portal, Hosting Provisioning Service, multi-server, chuyển account |
| [seed/ROADMAP.md](seed/ROADMAP.md) | 12 Phase, tiêu chí v0.1.0-alpha, Production Gate |
| [seed/DECISIONS.md](seed/DECISIONS.md) | Bảng trạng thái D-01…D-50 + lịch sử |
| [seed/DATABASE.md](seed/DATABASE.md) | Thay đổi schema cho phạm vi nội bộ |
| [seed/API.md](seed/API.md) | Admin API / Portal API, provisioning giữ chỗ |
| [seed/PHASE_1_PROMPTS.md](seed/PHASE_1_PROMPTS.md) | **7 prompt Phase 1** (Foundation, Architecture, Database, API Contracts, Design System), có kiểm thử và tiêu chí nghiệm thu |
| [seed/PHASE_STATUS.md](seed/PHASE_STATUS.md) · [seed/TEST_REPORT.md](seed/TEST_REPORT.md) | Tiến độ và kiểm thử |

## Chi tiết kỹ thuật (vẫn hiệu lực, theo seed khi mâu thuẫn)
[01 Yêu cầu và stack](01-REQUIREMENTS-FEASIBILITY.md) · [02 Kiến trúc](02-ARCHITECTURE.md) · [03 30 module](03-MODULES.md) · [04 Database](04-DATABASE.md) · [05 API](05-API.md) · [06 Agent security](06-AGENT-SECURITY.md) · [07 Cách ly và quota](07-HOSTING-ISOLATION.md) · [08 Backup](08-BACKUP.md) · [09 Docker](09-DOCKER.md) · [10 Installer](10-INSTALLER.md) · [11 Roadmap chi tiết Phase 1–8](11-ROADMAP.md) · [12 Prompt và cơ chế tiến độ](12-PHASE-PROMPTS.md) · [13 Nghiệm thu và rủi ro](13-ACCEPTANCE-AND-RISKS.md)

## Lịch sử (DEFERRED / OUT OF SCOPE)
[14 Khách hàng bên ngoài](14-CUSTOMER-MULTI-TENANT.md) · [15 Hosting Provider](15-HOSTING-PROVIDER.md)
