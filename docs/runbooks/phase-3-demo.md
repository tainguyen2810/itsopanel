# Runbook: chạy thử Phase 3 trên stack thật

Phase 3 nối giao diện với Laravel + PostgreSQL + Redis + mock agent (không còn MSW). Runbook này chỉ dành cho **máy dev**: mật khẩu và secret TOTP bên dưới là giá trị cố định cho dev, `DemoSeeder` từ chối chạy khi `APP_ENV=production`. Không dùng trên máy chủ thật.

## 1. Chuẩn bị (một lần)

```bash
make setup                                   # dependency web/api/agent
cp apps/api/.env.example apps/api/.env       # nếu chưa có (không commit .env)
cd apps/api && php artisan key:generate
# PostgreSQL 16 + Redis: dùng dịch vụ sẵn có hoặc `make services-up` (Docker)
php artisan migrate:fresh --seed             # bảng + vai trò, quyền, cài đặt mặc định
php artisan db:seed --class=DemoSeeder       # người dùng, gói, tài khoản demo
```

## 2. Chạy

```bash
make dev
```

`make dev` bật Vite (5173), Laravel (8000), mock agent (Unix socket), queue worker (`queue:work`), rồi chờ agent sẵn sàng để chạy `itso:server-local` (đăng ký server `srv-local`) và `itso:reconcile` (đồng bộ trạng thái account với agent).

- Admin Panel: <http://127.0.0.1:5173/admin/>
- User Portal: <http://127.0.0.1:5173/portal/>

## 3. Tài khoản demo (mật khẩu chung `password-dev-only`)

| Email | Realm | Vai trò | Ghi chú |
|---|---|---|---|
| `superadmin@itso.local` | admin | SUPER_ADMIN | MFA TOTP, secret `ITSODEVTOTPSECRETONLYFORLOCALDEV` (thêm vào app xác thực hoặc `oathtool --totp -b <secret>`) |
| `minh.tran@itso.local` | admin | ADMIN | phạm vi: `srv-local` |
| `lan.pham@itso.local` | admin | ADMIN | không có phạm vi (chỉ thấy dữ liệu chung) |
| `it@anphat.vn` | portal | USER | sở hữu `anphat` (hoạt động), `oldshop` (đã chấm dứt) |
| `marketing@itso.vn` | portal | USER | sở hữu `mktitso` |
| `hoa.le@example.vn` | portal | USER | sở hữu `lehoa` (tạm khóa) |

Gói: `basic`, `business`, `pro` (lấy từ `contracts/examples/demo-dataset.json`).

Server chặn dùng lại cùng một mã TOTP trong một chu kỳ 30 giây; đăng nhập lại ngay thì chờ mã mới.

## 4. Lệnh hữu ích

| Việc | Lệnh (trong `apps/api`) |
|---|---|
| Đồng bộ lại trạng thái account với agent | `php artisan itso:reconcile` hoặc `--account=<username>` |
| Cập nhật số liệu dùng (disk, inode…) | `php artisan itso:usage-refresh` |
| Đăng ký / làm mới server cục bộ | `php artisan itso:server-local` |
| Kiểm chuỗi băm audit | `php artisan itso:audit-verify` |
| Làm lại dữ liệu từ đầu | `php artisan migrate:fresh --seed && php artisan db:seed --class=DemoSeeder` |

## 5. E2E trên stack thật

Khi `make dev` đang chạy và DB đã seed:

```bash
make test-e2e-real
```

Bộ test (`apps/web/e2e-real/`) đăng nhập Admin có MFA, tạo user portal, tạo gói, tạo account (job qua mock agent → Hoạt động), khóa/mở khóa; đăng nhập Portal chỉ thấy account của mình; phiên sai realm bị từ chối. Mỗi lần chạy tạo dữ liệu với hậu tố ngẫu nhiên nên chạy lại được trên cùng DB.

## 6. Giới hạn của Phase 3

- Trang của Phase sau (website, database, backup, bảo mật, giám sát…) hiện "Chưa có ở bản này": API trả 404 `not_available`.
- Purge và chuyển server trả 501 (`purge_not_available`, `migration_not_available`).
- Mock agent không đổi gì trên hệ thống thật.
