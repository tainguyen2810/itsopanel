# ADR 0014: Vhost Nginx sinh từ template, kiểm `nginx -t` và tự hoàn tác

- **Trạng thái:** Proposed (chờ duyệt cùng Phase 5)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-67, D-63, D-12

## Bối cảnh

Mỗi website cần một server block Nginx. Cấu hình sai (do panel sinh lỗi hoặc do dữ liệu người dùng) có thể làm `nginx` không reload được, kéo theo mọi site trên server. Chèn chuỗi vào cấu hình (`;`, `{}`, xuống dòng, biến `$`) là đường tấn công thẳng vào web server chạy root.

## Quyết định

1. Một file cho mỗi website: `/etc/nginx/sites-enabled/itso-<website_uuid>.conf`, chỉ agent ghi (root 0644). File toàn server: `/etc/nginx/conf.d/itso-global.conf` (op `nginx.global.apply`).
2. Nội dung sinh bằng `text/template` của Go từ **giá trị đã validate** theo schema op (domain chữ thường punycode, `RelPath` không `..`, `NginxSize`, `HeaderValue` cấm `;{}"'\$` và CRLF, `UrlPath`, `RedirectTarget`, cổng proxy 1024–65535 chỉ tới `127.0.0.1`). Agent validate lại trước khi render (không tin panel). Không có ô cấu hình tự do; `website_settings.custom_snippet` DEFERRED.
3. Ba loại site: `php` (fastcgi tới socket pool của site, D-68), `static`, `proxy` (`proxy_pass http://127.0.0.1:<port>`). Domain `redirect` sinh server block trả 301 về domain chính. Redirect theo đường dẫn: `location = <from> { return <code> <to>; }`.
4. Mọi vhost có: `root /home/<user>/sites/<site_dir>/<document_root>`, `disable_symlinks if_not_owner from=$document_root`, `access_log`/`error_log` trong `sites/<site_dir>/logs/`, `location ^~ /.well-known/acme-challenge/` trỏ webroot chung `/var/lib/itso/acme/webroot`, chặn file ẩn (trừ `.well-known`). TLS: `ssl_certificate /etc/itso/certs/<cert_uuid>/fullchain.pem`, HSTS và chuyển HTTPS là tùy chọn.
5. Áp dụng (`nginx.vhost.apply`):
   1. Render, so sánh sha256 với file hiện có → giống nhau thì trả `changed=false`, không reload (idempotent).
   2. Lưu bản cũ (nếu có) ra `.itso-prev`, ghi bản mới atomic.
   3. Chạy `nginx -t`. Lỗi → khôi phục bản cũ (hoặc xóa file nếu site mới), trả `config_test_failed` kèm dòng lỗi đã rút gọn, **không reload**.
   4. Đúng → `systemctl reload nginx`, xóa `.itso-prev`.
6. Tạm khóa account: panel gọi lại `nginx.vhost.apply` với `suspended: true` → vhost trả trang tạm khóa tĩnh (503) cho mọi đường dẫn trừ ACME challenge. Không có op `site.suspend` riêng.
7. Xóa site: `nginx.vhost.remove` xóa file, `nginx -t`, reload. Dữ liệu trong home giữ nguyên.

## Hệ quả

- Một vhost lỗi không làm hỏng site khác vì không bao giờ reload với cấu hình test lỗi.
- Không hỗ trợ tùy biến Nginx tự do ở Phase 5; nhu cầu đặc biệt đi qua tham số mới có schema.
- Test: golden file cho từng loại vhost; test rollback bằng runner giả trả lỗi `nginx -t`; VM: 20 site + ép lỗi (tests/vm Phase 5).
