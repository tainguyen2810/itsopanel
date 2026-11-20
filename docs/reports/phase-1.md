# Báo cáo Phase 1 — Foundation, Architecture, Database, API Contracts, Design System

- **Trạng thái:** ✓ hoàn tất, **chờ duyệt**. Không bắt đầu Phase 2 khi chưa có lệnh.
- **Thời gian:** 2026-11-20. Nhánh `phase-1`, merge `--no-ff` vào `main` ở Git local (không push, không remote) theo yêu cầu "làm hàng loạt và tự merge".
- **Phạm vi giữ đúng:** không có code nghiệp vụ, không thao tác hệ thống thật, không deploy. Billing/WooCommerce/thanh toán: OUT OF SCOPE. Public Provisioning API: DEFERRED.

## 1. Đã làm

| Prompt | Kết quả chính | Commit |
|---|---|---|
| 1.1 Repo | Git local (D-51), cấu trúc repo, `CLAUDE.md`, Makefile, `check-structure.sh` | f7ccc70, ece3ec8, 09d71a8 |
| 1.2 Kiến trúc | `ARCHITECTURE.md` (6 sơ đồ Mermaid), 10 ADR, threat model, sitemap UI, `make docs-check` | b6ac081 |
| 1.3 Database | DBML 78 bảng → `itso.sql` + `extras.sql` (trigger realm, purge guard D-46, audit append-only + hash chain, partition), ERD 9 SVG, `db-verify` 41 test SQL trên PostgreSQL 16 | 1de27fe |
| 1.4 Contracts | OpenAPI admin 208 + portal 90 operation, 61 agent op có JSON Schema, 93 evil-input vector, demo dataset, Redocly + ajv | 6a06302 |
| Mockup | Dashboard Admin desktop/tablet/mobile (theo yêu cầu, trước 1.5) | 7aefaf0 |
| 1.5 Scaffold | apps/web (React 19, Vite, Tailwind 4, 2 entry), apps/api (Laravel 13, RFC 9457, Pest, Larastan + rule cấm exec), Go mock agent qua unix socket, `make setup/dev/test/lint`, runbook dev | 67211b5 … 28dfbdc |
| 1.6 Design System | Token Light/Dark từ mockup, sinh CSS + `@theme` Tailwind 4, tương phản AA 84/84; lint cấm màu cứng; ThemeProvider không nháy; i18n VI/EN; 25 component; AdminShell + PortalShell; trang `/design` chỉ ở dev; Playwright 14 ảnh + axe | 6e48570, 18f5ea6, 50087c3, c550e17 |
| 1.7 CI & codegen | TS types + client từ OpenAPI; Go structs từ agent schemas; `make codegen-check`; CI 7 job; `make check` 21 bước; runbook GitHub; báo cáo này | cde2c40, f1d6205, 62c12f2 |

## 2. File chính

| Khu vực | Đường dẫn |
|---|---|
| Kế hoạch, trạng thái | `PROJECT_PLAN.md`, `ROADMAP.md`, `DECISIONS.md`, `PHASE_STATUS.md`, `TEST_REPORT.md` |
| Kiến trúc | `ARCHITECTURE.md`, `docs/adr/`, `docs/security/`, `docs/ui/sitemap.md` |
| Database | `database/schema/itso.dbml`, `itso.sql`, `extras.sql`, `database/tests/`, `database/docs/erd/` |
| Contracts | `contracts/openapi/`, `contracts/agent-ops/`, `contracts/test-vectors/`, `contracts/tools/` |
| Codegen | `apps/web/src/api/generated/{admin,portal}/schema.ts`, `agent/internal/contracts/types_gen.go`, `scripts/codegen-check.sh` |
| Design System | `design/tokens/tokens.json`, `design/tools/`, `design/docs/README.md`, `apps/web/src/ui/`, `apps/web/src/shared/{shell,theme,i18n}/` |
| Ứng dụng | `apps/web/`, `apps/api/`, `agent/` |
| CI, kiểm tra | `.github/workflows/ci.yml`, `scripts/check-all.sh`, `scripts/check-ci.py` |
| Runbook | `docs/runbooks/dev-setup.md`, `docs/runbooks/connect-github.md` |
| Ảnh | `docs/screenshots/phase-1/`, `docs/screenshots/design-system/` (14 ảnh) |

## 3. Cách chạy thử

```bash
git clone <repo> itso-panel && cd itso-panel
make setup        # pnpm, composer, .env + APP_KEY, build mock agent
make dev          # http://127.0.0.1:5173/admin/ · /portal/ · /design/ (chỉ dev)
make check        # toàn bộ pipeline như CI, in bảng kết quả
```

Tùy chọn: `make services-up` (PostgreSQL 16 + Redis 7 bằng Docker) để bước `test-api-pg` chạy thay vì SKIP; `make screenshots` để chụp lại ảnh Design System.

## 4. Kết quả test

Chạy `make check` trên `phase-1` (máy cloud, có PostgreSQL 16 và Redis 7 cục bộ):

| Bộ test | Lệnh | Kết quả | Số lượng |
|---|---|---|---|
| Cấu trúc repo | `make structure` | PASS | 22 thư mục, 18 file bắt buộc |
| Tài liệu | `make docs-check` | PASS | markdownlint 0 lỗi, link nội bộ, 8 khối Mermaid |
| Workflow CI | `scripts/check-ci.py` | PASS | 7 job, 16 lệnh make có thật |
| Database | `make db-verify` | PASS | 41/41 test SQL |
| Contracts | `make contracts-check` | PASS | sinh lại không diff, Redocly 0 lỗi, ajv 6 mẫu hợp lệ + 10 mẫu sai bị từ chối |
| Codegen | `make codegen-check` | PASS | TS admin/portal, Go structs, bản nhúng schema; thử âm tính 3 file → lỗi |
| Token + tương phản | `make tokens-check` | PASS | 84/84 cặp WCAG AA |
| Web lint | `make lint-web` | PASS | ESLint (cấm màu cứng, cấm Admin API ở portal), Prettier, tsc, i18n 187 key |
| Web unit | `make test-web` | PASS | 26 test Vitest |
| Web build | `make build-web` | PASS | không chứa `/design` |
| Web E2E | `make test-e2e` | PASS | 30 test Playwright, axe 0 lỗi critical/serious (12 lần quét) |
| API lint | `make lint-api` | PASS | Pint, PHPStan level 8 + Larastan 0 lỗi |
| API (SQLite) | `make test-api` | PASS | 14 test, 63 assertion |
| API (PostgreSQL 16 + Redis 7) | `make test-api-pg` | PASS | 14 test; thử âm tính sai cổng PG → test trạng thái DB đỏ |
| Chặn lệnh hệ thống | `make no-exec` | PASS | 0 vi phạm |
| Agent lint | `make lint-agent` | PASS | gofmt, go vet |
| staticcheck | `staticcheck ./...` | **SKIP** | máy cloud không cài được; CI chạy bản 2025.1.1 |
| Agent test | `make test-agent` | PASS | 4 gói `-race`, gồm 3 test cho struct sinh ra |
| Fuzz | `make test-fuzz` | PASS | 30 giây, khoảng 300 nghìn lượt, không panic |
| Build agent | `make build-agent` | PASS | |
| Repo sạch sau khi chạy | (trong `make check`) | PASS | không phát sinh thay đổi |

Kết quả giống hệt khi chạy trên clean clone (mục 7).

## 5. Tiêu chí nghiệm thu Phase 1 (Definition of Done)

| Tiêu chí | Đạt | Bằng chứng |
|---|---|---|
| Tất cả acceptance của 1.1–1.6 | ✓ | `TEST_REPORT.md`, mục Acceptance từng prompt |
| `make check` xanh; codegen không diff | ✓ | Mục 4 và 7; `codegen-check` PASS |
| Không code nghiệp vụ, không thao tác hệ thống, không deploy | ✓ | Chỉ có health/version/status và mock agent; `make no-exec` PASS; không có remote, không push |
| Báo cáo đầy đủ; PHASE_STATUS: Phase 1 ✓ (chờ duyệt) | ✓ | File này; `PHASE_STATUS.md` |

## 6. Quyết định mới (Proposed, chờ duyệt)

- **D-54:** token lấy `tokens.json` làm nguồn, preset Tailwind 4 là `@theme inline` sinh ra, Light mặc định + class `.dark`, mọi cặp màu khai báo đạt AA.
- **D-55:** codegen TS bằng openapi-typescript + openapi-fetch, Go structs bằng generator Python trong `contracts/tools`; file sinh được commit và kiểm bằng `make codegen-check`.

Lệch có chủ đích đã ghi ở 1.5: portal chỉ hiện health API (thông tin agent là Admin-only); endpoint version là `/api/v1/admin/system/version` theo contract.

## 7. Clean clone

`git clone -b phase-1` vào thư mục mới → `make setup && make check`: **20 PASS · 1 SKIP (staticcheck) · 0 FAIL**, repo sạch sau khi chạy. Tổng 10 phút 54 giây: `make setup` khoảng 8,5 phút (máy cloud chặn tải zip từ GitHub nên Composer phải clone git), `make check` 134 giây. Trên máy dev thường setup dự kiến 3–6 phút.

## 8. Rủi ro và việc còn lại

| Mục | Ảnh hưởng | Đề xuất |
|---|---|---|
| CI chưa từng chạy trên GitHub (repo chưa có remote) | Workflow chỉ được kiểm bằng `check-ci.py` (actionlint không tải được ở máy cloud) | Khi kết nối GitHub theo runbook, chạy CI lần đầu và sửa nếu có |
| staticcheck chưa chạy local | Có thể có cảnh báo khi CI chạy | Chạy `staticcheck ./...` trên máy dev hoặc xem job `agent` lần đầu |
| `make services-up` (Docker) chưa chạy thử | Máy cloud không có Docker; PG/Redis kiểm bằng bản cài trực tiếp | Thử trên máy dev có Docker |
| Chỉ kiểm Chromium | Firefox/Safari chưa kiểm | Thêm project Playwright ở Phase 2 nếu cần |
| Bundle web 521 kB (gzip 164 kB) | Tải trang đầu chậm hơn cần thiết | Tách theo route (lazy) ở Phase 2 |
| Pest chỉ có test hệ thống | Chưa có test nghiệp vụ | Phase 3 (auth, RBAC, accounts) |

## 9. Commit cuối

Xem `git log -1` trên `main` sau khi merge (merge commit `phase-1 → main`). Danh sách commit Phase 1: `git log --oneline main~1..phase-1` trước merge, hoặc `git log --oneline --first-parent main` sau merge.
