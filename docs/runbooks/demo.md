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
- Mô phỏng hạ tầng: thêm server thì agent "kết nối" sau 6 giây; tường lửa áp dụng an toàn tự hoàn tác nếu
  không xác nhận trong thời hạn; terminal chỉ mô phỏng, không chạy lệnh.
- Mô phỏng hosting: tạo account chạy job rồi chuyển `active` (có domain thì tạo luôn website); đổi giới hạn gói
  tạo phiên bản mới (D-43); chuyển server dừng ở bước kiểm tra dữ liệu chờ cutover hoặc hoàn tác; purge 2 bước
  (D-46) cần Super Admin thứ hai: lên lịch bằng "Quản trị hệ thống", đổi vai trò sang "Nguyễn Hải" để xác nhận.
- Mô phỏng Hosting II (`handlers/sites.ts`): website/domain/SSL/Nginx/PHP/WAF và database/SFTP/cron/DNS chạy job rồi cập nhật dữ liệu; File Manager là cây thư mục ảo theo từng account (sinh khi mở lần đầu, chặn đường dẫn ngoài home, lưu có etag → 412 khi xung đột); log Nginx sinh ngẫu nhiên; Git deploy tạo release mới, deploy chồng bị khóa, rollback đánh dấu release sau là `rolled_back`. Dữ liệu phụ lưu theo khóa `fs@<account>`, `dns@<zone>`, `runs@<cron>`, `nginx@/php@/waf@<website>`.
- Mô phỏng quản trị (`handlers/governance.ts`): SSH/fail2ban/allowlist chỉ Super Admin (If-Match, chặn allowlist rỗng), đích sao lưu không hạ Object Lock và không lưu bí mật, snapshot còn khóa bất biến không xóa được, khôi phục ghi đè phải gõ username, người dùng/phạm vi ADMIN/impersonate có lý do (ghi audit), quy tắc cảnh báo, xuất audit CSV (`text/csv`), cài đặt chỉ Super Admin. Phạm vi ADMIN lưu theo khóa `scopes@<user>`.
- Vai trò: nút **Demo** trên topbar chuyển người dùng mẫu. Admin: hai Super Admin (Quản trị hệ thống,
  Nguyễn Hải) hoặc Admin (Trần Minh, chỉ thấy server srv-hn-01 và account lehoa). Portal: An Phát, Phòng Marketing, Lê Hoa. Route ngoài quyền hiện
  trang 403.

## Thêm endpoint giả lập

1. Endpoint phải có trong OpenAPI (`router.ts` chỉ nhận đường dẫn thuộc `paths` sinh từ contracts).
2. Đăng ký bằng `on(method, path, ctx => …)` trong `apps/web/src/demo/handlers/`.
3. `npx vitest run src/demo` kiểm response theo schema; GET mới tự được kiểm.
