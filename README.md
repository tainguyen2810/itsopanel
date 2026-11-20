# ITSO Panel

Hệ thống quản trị máy chủ và Web Hosting **dùng nội bộ** cho Ubuntu 24.04 LTS. Cài bằng một lệnh, hoàn tất bằng Web Wizard, quản trị qua Private Admin Panel, người dùng được cấp tài khoản dùng User Hosting Portal.

> **Trạng thái:** Phase 1 — Foundation (đang xây dựng). Chưa có bản cài đặt.

## Thành phần

| Thành phần | Công nghệ | Thư mục |
|---|---|---|
| Admin Panel + User Hosting Portal | React, TypeScript, Vite, Tailwind CSS, shadcn/ui | `apps/web` |
| REST API | Laravel, PostgreSQL, Redis | `apps/api` |
| Server Agent, CLI `itso`, gateway | Go | `agent` |
| API & agent contracts | OpenAPI 3.1, JSON Schema | `contracts` |
| Database schema | DBML → PostgreSQL | `database` |
| Design System | Design tokens Light/Dark | `design` |
| Installer | Bash bootstrap + `itso install` | `installer`, `packaging` |

## Đọc tài liệu theo thứ tự

1. [PROJECT_PLAN.md](PROJECT_PLAN.md): phạm vi và nguyên tắc
2. [ARCHITECTURE.md](ARCHITECTURE.md): kiến trúc
3. [ROADMAP.md](ROADMAP.md): 12 Phase
4. [DECISIONS.md](DECISIONS.md): quyết định đã duyệt
5. [DATABASE.md](DATABASE.md), [API.md](API.md)
6. [PHASE_STATUS.md](PHASE_STATUS.md), [TEST_REPORT.md](TEST_REPORT.md): tiến độ
7. Chi tiết: [docs/planning/](docs/planning/README.md)

## Lệnh

```bash
make help        # liệt kê lệnh
make structure   # kiểm tra cấu trúc repo
```

Trên Windows: `.\scripts\dev.ps1 help` (chạy qua WSL2).

## Quy tắc đóng góp

Xem [CLAUDE.md](CLAUDE.md).

© 2026 ITSO, sử dụng nội bộ.
