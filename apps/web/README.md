# apps/web

Frontend React 19 + TypeScript (strict) + Vite + Tailwind CSS v4 + shadcn/ui (`components.json`) + Lucide + TanStack Query.

Hai entry, dùng chung `src/shared`:

| Entry               | Mã nguồn             | URL dev                         |
| ------------------- | -------------------- | ------------------------------- |
| Private Admin Panel | `src/entries/admin`  | `http://127.0.0.1:5173/admin/`  |
| User Hosting Portal | `src/entries/portal` | `http://127.0.0.1:5173/portal/` |

Prompt 1.5 chỉ có trang trạng thái tạm (chưa có UI thật). Design System ở Prompt 1.6, demo UI đầy đủ ở Phase 2.

## Lệnh (chạy trong `apps/web`, hoặc dùng `make` ở gốc repo)

| Việc                                               | Lệnh                  |
| -------------------------------------------------- | --------------------- |
| Dev server (proxy `/api` → Laravel `ITSO_API_URL`) | `corepack pnpm dev`   |
| Test (Vitest + Testing Library, jsdom)             | `corepack pnpm test`  |
| Lint (ESLint + Prettier + `tsc`)                   | `corepack pnpm lint`  |
| Build (`dist/admin`, `dist/portal`)                | `corepack pnpm build` |

## Quy tắc

- ESLint cấm `dangerouslySetInnerHTML`, gán `innerHTML`/`outerHTML`, `eval`.
- Portal không gọi endpoint `/api/v1/admin/*` (có test kiểm).
- Phiên bản dependency phải phát hành ≥ 14 ngày (`minimumReleaseAge` trong `pnpm-workspace.yaml`).
- Type API hiện viết tay trong `src/shared/api/client.ts`; Prompt 1.7 thay bằng type sinh từ OpenAPI.
