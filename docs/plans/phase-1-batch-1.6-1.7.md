# Kế hoạch chạy liền Prompt 1.6 → 1.7 → merge `main`

Ngày lập: 2026-11-20. Người yêu cầu: chạy hàng loạt, tự merge (local). Dừng ở cuối Phase 1, **không** bắt đầu Phase 2.

## 0. Nguyên tắc chung (để tránh lỗi)

1. **Mỗi bước nhỏ đều có cổng kiểm**: viết xong một nhóm, chạy `test` + `lint` của phần đó ngay, chưa xanh thì chưa sang nhóm sau.
2. **Commit nhỏ theo nhóm** trên `phase-1` (Conventional Commits `feat(p1)`, `test(p1)`, `docs(p1)`), mỗi commit đều xanh, nên luôn quay lại được.
3. **Không phá cái đã xanh**: sau mỗi nhóm chạy lại `make test` + `make lint` của 1.5 (web, api, agent, no-exec).
4. **Dependency**: chỉ dùng bản phát hành ≥ 14 ngày (pnpm `minimumReleaseAge` tự chặn); khóa `@playwright/test` đúng **1.63.0** để dùng Chromium có sẵn, tránh tải trình duyệt.
5. **Không đụng hệ thống**: không deploy, không push, không tạo remote. Merge `phase-1 → main` chỉ ở Git local.
6. **Số liệu thật**: TEST_REPORT ghi lệnh và kết quả đã chạy; bước nào không chạy được trong máy cloud (Docker, GitHub Actions) ghi rõ là chưa kiểm.

## 1. Prompt 1.6 — Design System

| # | Việc | Sản phẩm | Cổng kiểm |
|---|---|---|---|
| 1.6.1 | Token nguồn Light/Dark theo mockup (navy, xanh dương, xanh lá, tím, vàng; Be Vietnam Pro): màu bg/surface/border/fg/muted/primary/success/warning/danger/info/chart-1..8, radius, spacing, shadow, typography, z-index | `design/tokens/tokens.json` | JSON schema của token tự kiểm |
| 1.6.2 | Script sinh CSS variables (`:root` + `.dark`) và "preset" Tailwind v4 dạng `@theme inline` (Tailwind 4 không còn preset JS) | `design/tools/gen-tokens.mjs` → `apps/web/src/shared/styles/tokens.css` | Sinh lại không diff |
| 1.6.3 | Script tương phản WCAG AA cho mọi cặp fg/bg khai báo trong token | `design/tools/check-contrast.mjs` | 0 cặp dưới 4.5:1 (chữ) / 3:1 (UI) |
| 1.6.4 | Rule lint cấm màu hard-code trong component (`#hex`, `rgb()`, `hsl()`, class palette Tailwind như `bg-red-500`, `bg-[#…]`) | `eslint.config.js` | Thử âm tính: thêm màu cứng → lint đỏ |
| 1.6.5 | ThemeProvider light/dark/system, lưu lựa chọn (try/catch storage), script chặn nháy theme chạy trước React | `src/shared/theme/*`, `public/theme-init.js` | Vitest: đổi theme, storage lỗi vẫn chạy, theo `prefers-color-scheme` |
| 1.6.6 | i18n: i18next + react-i18next, VI mặc định + EN, namespace theo module; format số/ngày/dung lượng theo locale; script tìm key thiếu | `src/shared/i18n/*`, `locales/{vi,en}/*.json`, `scripts/check-i18n.mjs` | Key thiếu = 0; Vitest cho formatter |
| 1.6.7 | ≥ 25 component nền dựa trên shadcn/ui + Radix: Button, Input, Textarea, Select, Checkbox, Switch, Label, Badge, StatusBadge (desired/observed), Card, StatCard, Gauge, ProgressBar, Tabs, Dialog, ConfirmDialog (gõ tên), Drawer, DropdownMenu, Tooltip, Toast (sonner), Alert, EmptyState, Skeleton, Breadcrumb, Pagination, DataTable (TanStack Table: sort, filter, chọn dòng, card ở mobile), FormField (RHF + zod), CodeBlock, JobProgress, Area/Bar/Donut chart (Recharts, màu token) | `apps/web/src/ui/*` | Vitest: DataTable, ConfirmDialog, ThemeProvider, FormField |
| 1.6.8 | AdminShell (sidebar theo mockup, topbar: Ctrl+K, theme, ngôn ngữ, chuông, user menu) + PortalShell (gọn, menu USER); sidebar thu gọn, drawer ở 390px | `src/shared/shell/*`, cập nhật 2 entry | Vitest render; Playwright ở 390/1440 |
| 1.6.9 | Trang `/design/` chỉ chạy ở dev (entry riêng, không đưa vào build) hiển thị mọi component ở light/dark, VI/EN | `apps/web/design/index.html`, `src/entries/design/*` | `vite build` không chứa `/design` |
| 1.6.10 | Playwright (`--trace off`, deviceScaleFactor 2): `/design`, AdminShell, PortalShell × 1440/390 × light/dark = 12 ảnh; axe-core trên `/design` | `apps/web/e2e/*`, `docs/screenshots/design-system/*.png` | axe 0 lỗi critical/serious |
| 1.6.11 | Tài liệu nguyên tắc màu, spacing, trạng thái, a11y | `design/docs/README.md` | `make docs-check` |
| 1.6.12 | Cập nhật PHASE_STATUS, TEST_REPORT, commit | | `make test` + `make lint` xanh |

Rủi ro đã thấy trước và cách xử lý:

- **Font**: không gọi Google Fonts lúc chạy (panel nội bộ, có thể không có Internet) → dùng `@fontsource/be-vietnam-pro` tự host.
- **Chart trong jsdom** không đo được kích thước → test chart bằng Playwright, Vitest chỉ test logic.
- **Script chặn nháy theme** là inline/script sớm → đặt ở file tĩnh `public/theme-init.js` (không inline) để sau này CSP chặt vẫn chạy.
- **Màu chart trong Recharts** cần giá trị thật → đọc CSS variable (`var(--chart-1)`), không chép hex vào component.
- **Mockup chỉ có Dark** → Light tự suy từ cùng bảng màu, có kiểm tương phản AA.

## 2. Prompt 1.7 — CI, codegen, kiểm tra tổng, báo cáo Phase 1

| # | Việc | Sản phẩm | Cổng kiểm |
|---|---|---|---|
| 1.7.1 | TS types + client từ OpenAPI (openapi-typescript + openapi-fetch) → `apps/web/src/api/generated/{admin,portal}`; thay type viết tay ở `client.ts` | `make codegen` | `tsc` xanh, test web vẫn xanh |
| 1.7.2 | Go structs từ agent schemas (generator Python trong `contracts/tools`, không thêm tool ngoài) → `agent/internal/contracts/types_gen.go`; gộp bước đồng bộ bản nhúng schema vào `make codegen` | `make codegen` | `go vet` + `go test -race` xanh |
| 1.7.3 | `make codegen-check`: sinh lại rồi so diff, có diff là lỗi | | Thử âm tính: sửa file sinh → lỗi |
| 1.7.4 | `.github/workflows/ci.yml`: structure, docs, database, contracts, web (lint, typecheck, vitest, build, Playwright), api (pint, larastan, pest với service PG + Redis, no-exec), agent (vet, staticcheck, test -race, fuzz 30s). Không bật, không push | | Kiểm cú pháp bằng `actionlint` nếu tải được |
| 1.7.5 | `make check`: chạy toàn bộ pipeline local, in bảng kết quả từng bước, exit ≠ 0 nếu có bước đỏ | `scripts/check-all.sh` | `make check` exit 0 |
| 1.7.6 | `docs/runbooks/connect-github.md` (thêm remote, push, bật Actions — chỉ hướng dẫn) | | `make docs-check` |
| 1.7.7 | `docs/reports/phase-1.md` theo mẫu; ROADMAP (Phase 1 ✓ chờ duyệt), PHASE_STATUS, TEST_REPORT (số test từng bộ) | | |
| 1.7.8 | Clean clone → `make setup && make check` | | xanh |

## 3. Merge và kết thúc

1. `make check` xanh trên `phase-1` và trên bản clone sạch.
2. `git checkout main && git merge --no-ff phase-1` (local), chạy lại `make check` trên `main`.
3. Đồng bộ bản lưu `/mnt/project-files/repo/` + bundle; cập nhật memory.
4. Báo cáo Phase 1 và **dừng**. Không bắt đầu Phase 2 khi chưa có lệnh.
