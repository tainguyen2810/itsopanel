# apps/web

Frontend React 19 + TypeScript (strict) + Vite + Tailwind CSS v4 + shadcn/ui (`components.json`) + Lucide + TanStack Query.

Hai entry, dùng chung `src/shared`:

| Entry                                | Mã nguồn             | URL dev                         |
| ------------------------------------ | -------------------- | ------------------------------- |
| Private Admin Panel                  | `src/entries/admin`  | `http://127.0.0.1:5173/admin/`  |
| User Hosting Portal                  | `src/entries/portal` | `http://127.0.0.1:5173/portal/` |
| Design System (chỉ dev, không build) | `src/entries/design` | `http://127.0.0.1:5173/design/` |

Thư mục chính:

| Thư mục                        | Nội dung                                                                    |
| ------------------------------ | --------------------------------------------------------------------------- |
| `src/ui`                       | Component nền (shadcn/ui + Radix), export từ `src/ui/index.ts`              |
| `src/shared/shell`             | AdminShell, PortalShell, sidebar, topbar, Ctrl+K                            |
| `src/shared/theme`             | ThemeProvider light/dark/system; `public/theme-init.js` chặn nháy theme     |
| `src/shared/i18n`              | i18next VI (mặc định) + EN, formatter theo locale, `locales/{vi,en}/*.json` |
| `src/shared/styles/tokens.css` | **Sinh từ** `design/tokens/tokens.json` (`make tokens`), không sửa tay      |
| `e2e`                          | Playwright: ảnh chụp, hành vi shell, axe-core                               |

Nguyên tắc màu, spacing, trạng thái, a11y: [design/docs/README.md](../../design/docs/README.md). Trang Admin/Portal hiện chỉ có shell và trạng thái môi trường dev; UI nghiệp vụ ở Phase 2.

## Lệnh (chạy trong `apps/web`, hoặc dùng `make` ở gốc repo)

| Việc                                               | Lệnh                       |
| -------------------------------------------------- | -------------------------- |
| Dev server (proxy `/api` → Laravel `ITSO_API_URL`) | `corepack pnpm dev`        |
| Test (Vitest + Testing Library, jsdom)             | `corepack pnpm test`       |
| Lint (ESLint + Prettier + `tsc`)                   | `corepack pnpm lint`       |
| Build (`dist/admin`, `dist/portal`)                | `corepack pnpm build`      |
| Playwright (Chromium có sẵn, `--trace off`)        | `corepack pnpm e2e`        |
| Kiểm key i18n VI/EN                                | `corepack pnpm i18n:check` |

## Quy tắc

- ESLint cấm màu hard-code (`#hex`, `rgb()`, `hsl()`, `bg-red-500`, `bg-[#…]`): chỉ dùng class token như `bg-surface`, `text-danger-text`.
- Mọi chuỗi giao diện qua i18n, có cả VI và EN.
- `@playwright/test` khóa ở 1.63.0 để dùng Chromium có sẵn, không tải trình duyệt.
- ESLint cấm `dangerouslySetInnerHTML`, gán `innerHTML`/`outerHTML`, `eval`.
- Portal không gọi endpoint `/api/v1/admin/*` (có test kiểm).
- Phiên bản dependency phải phát hành ≥ 14 ngày (`minimumReleaseAge` trong `pnpm-workspace.yaml`).
- Type API sinh từ OpenAPI (`make codegen` → `src/api/generated/{admin,portal}`); gọi API qua `src/api/{admin,portal,public}.ts` (openapi-fetch). Portal và `src/shared` không được import Admin API (ESLint chặn).
