# Runbook — Giao diện demo (Phase 2)

Bản demo chạy toàn bộ Admin Panel và User Hosting Portal **không cần Laravel, PostgreSQL hay agent**:
mọi request `/api/v1/...` được Mock Service Worker (MSW) trả lời theo đúng OpenAPI trong `contracts/`.

## Chạy

```bash
make dev-demo          # = cd apps/web && pnpm dev:demo → http://127.0.0.1:5173/admin/ và /portal/
make build-demo        # build vào apps/web/dist-demo + kiểm build thường không chứa MSW
cd apps/web && pnpm preview:demo   # xem bản build demo
```

## Cách hoạt động

- `vite --mode demo` đặt `import.meta.env.VITE_DEMO = '1'`; `main.tsx` gọi `startDemoIfEnabled()` để bật
  service worker (`mockServiceWorker.js` do plugin `msw/vite` phục vụ/xuất, không nằm trong `public/`).
  Build thường loại bỏ nhánh này hoàn toàn (`scripts/check-demo-build.sh` kiểm bằng grep).
- Dữ liệu: bản sao trong bộ nhớ của `contracts/examples/demo-dataset.json` (sinh bởi
  `contracts/tools/demo.py`, kiểm nhất quán bởi `check_demo.py`). Tải lại trang là về dữ liệu gốc.
- Thao tác ghi trả `202` + Job; job tự chạy từng bước theo thời gian và hiện trong drawer theo dõi job.
- Vai trò: nút **Demo** trên topbar chuyển người dùng mẫu. Admin: Super Admin hoặc Admin (Trần Minh, chỉ
  thấy server srv-hn-01 và account lehoa). Portal: An Phát, Phòng Marketing, Lê Hoa. Route ngoài quyền hiện
  trang 403.

## Thêm endpoint giả lập

1. Endpoint phải có trong OpenAPI (`router.ts` chỉ nhận đường dẫn thuộc `paths` sinh từ contracts).
2. Đăng ký bằng `on(method, path, ctx => …)` trong `apps/web/src/demo/handlers/`.
3. `npx vitest run src/demo` kiểm response theo schema; GET mới tự được kiểm.
