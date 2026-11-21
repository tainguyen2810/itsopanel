# Runbook Phase 5: Website, PHP, Nginx, SSL, DNS

Runbook cho người vận hành panel nội bộ. Áp dụng cho bản Phase 5 (Ubuntu 24.04, Nginx, PHP 8.3 từ kho Ubuntu, lego cho ACME, DNS qua Cloudflare API).

## 1. Chuẩn bị web stack

| Việc | Cách làm |
|---|---|
| Cài lần đầu | Wizard cài đặt, bước 4 **Stack**: bấm "Cài phần còn thiếu" (Nginx, PHP 8.3 FPM, lego). Bước này không bắt buộc |
| Cài sau | Máy chủ → Phần mềm (recipe `nginx`, `lego`) và Máy chủ → PHP (cài PHP 8.3, extension trong allowlist) |
| Email ACME | Đặt `ITSO_ACME_EMAIL=<hộp thư vận hành>` trong `/etc/itso/itso.env`, rồi khởi động lại panel: `sudo systemctl restart itso-web itso-worker@*`. Thiếu email thì xin chứng chỉ trả 409 |
| Môi trường ACME | `ITSO_ACME_DIRECTORY=letsencrypt` (mặc định production) hoặc `letsencrypt-staging` khi thử. `pebble` chỉ dùng cho VM test (`ITSO_ACME_ALLOW_PEBBLE=true`) |

## 2. Website

- **Tạo:** Website → Thêm website. Panel chạy job: tạo thư mục site (`fs.site_layout.ensure`) → PHP-FPM pool riêng theo uid account (`php.pool.apply`) → vhost Nginx (`nginx.vhost.apply`, có `nginx -t` trước khi reload) → (nếu chọn) xin chứng chỉ.
- **Gói hết hạn mức:** form báo "Gói hosting của account đã hết hạn mức website…". Nâng gói hoặc xóa bớt site.
- **Lỗi `nginx -t`:** drawer job hiện "Cấu hình mới không qua kiểm tra" kèm dòng lỗi gốc. Agent đã hoàn tác, các site khác vẫn chạy. Sửa cấu hình (thường là header tùy chỉnh, redirect) rồi lưu lại.
- **Tạm khóa account:** mọi site của account chuyển sang trang tạm khóa; mở khóa sẽ áp lại vhost.
- **Xóa:** Thao tác → Xóa website, gõ domain để xác nhận, rồi nhập lại mã TOTP (step-up). Panel gỡ vhost, pool và chứng chỉ; file trong `~/sites/<domain>` được giữ lại trong home của account.

## 3. SSL

| Tình huống | Xử lý |
|---|---|
| Xin Let's Encrypt lỗi `precondition_failed` | Domain chưa trỏ A/AAAA về máy chủ hoặc cổng 80 bị chặn. Kiểm DNS, firewall, rồi bấm lại "Xin chứng chỉ Let's Encrypt" |
| Gia hạn | `itso:certs-renew` chạy hằng ngày 03:17, gia hạn chứng chỉ ACME còn dưới 30 ngày. Lỗi → thông báo cho Super Admin và audit `failure`. Chạy tay: `php artisan itso:certs-renew --dry-run` |
| Chứng chỉ riêng | Tab SSL → Tải chứng chỉ riêng: dán fullchain và khóa riêng PEM không mật khẩu. Panel kiểm khóa khớp, còn hạn, đủ domain (wildcard chỉ phủ một nhãn). Khóa lưu mã hóa, không hiển thị lại, không tự gia hạn |
| Thay chứng chỉ đang dùng | Agent kiểm `nginx -t` rồi reload Nginx; lỗi thì khôi phục file cũ |

## 4. DNS (Cloudflare)

1. Super Admin: DNS → Nhà cung cấp DNS → Thêm Cloudflare. Token cần quyền **Zone:Read** và **DNS:Edit**; panel kiểm token với Cloudflare trước khi lưu, lưu mã hóa.
2. DNS → Gắn zone: zone phải có sẵn trong tài khoản Cloudflare. Gắn với tài khoản hosting (Admin chỉ thấy zone của account trong phạm vi) hoặc "Hệ thống".
3. Sửa record chạy bằng job: ghi Cloudflare trước, thành công mới lưu DB. Lỗi 4xx của Cloudflare → job `invalid_params` (không thử lại); 5xx/429 → thử lại theo backoff.
4. "Đồng bộ từ Cloudflare" (hoặc `itso:dns-sync`, mỗi giờ phút 23) lấy Cloudflare làm nguồn sự thật. Record loại panel chưa quản lý (HTTPS, SVCB…) giữ nguyên trên Cloudflare.
5. Gỡ zone khỏi panel không xóa gì trên Cloudflare. Xóa nhà cung cấp cần gỡ hết zone trước và cần step-up.

## 5. Kiểm thử trên VM

Xem `tests/vm/README.md`, mục Website. Tóm tắt (VM Ubuntu 24.04 dùng một lần, đã cài ITSO và Docker):

```bash
ITSO_PEBBLE_VM=1 bash tests/vm/pebble/start.sh
bash tests/vm/phase5.sh        # bảng kết quả ở /root/itso-vm-phase5.md
```

## 6. Sự cố thường gặp

| Triệu chứng | Kiểm |
|---|---|
| Site trả 502 | `systemctl status itso-php@8.3-<user>`; log `/var/log/itso/sites/<user>/<domain>/error.log` (tab Log của website) |
| Job đứng ở `queued` | Worker: `systemctl status 'itso-worker@*'`; agent: `itso doctor` |
| `agent_unavailable` | `systemctl status itso-agent`, socket `/run/itso/agent.sock` |
| HTTPS báo chứng chỉ sai | Tab SSL xem trạng thái; `sudo itso doctor` kiểm Nginx; chứng chỉ ở `/etc/itso/certs/<uuid>/` |
