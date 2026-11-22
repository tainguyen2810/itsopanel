# ADR 0044: WordPress Toolkit

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 10)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-99, D-82 (backup), Phase 6 (wp.install)

## Quyết định

1. **WP-CLI ghim:** recipe `wp-cli` đặt `/usr/local/lib/itso/wp-cli-<ver>.phar` (sha512 ghim trong agent). Chạy `php<phiên bản của site> wp-cli.phar --path=<docroot> --skip-plugins --skip-themes …` **dưới UID account** trong slice của account. Không có op `wp.cli` tự do; subcommand allowlist trong agent; slug plugin/theme theo `^[a-z0-9][a-z0-9_-]{0,99}$`; đường dẫn phải nằm trong home account.
2. **Op typed:** `wp.detect`, `wp.info`, `wp.install`, `wp.update`, `wp.clone`, `wp.harden`, `wp.admin_password`, `wp.maintenance`.
3. **Cập nhật an toàn** (job `wordpress.update`, chọn core/plugin/theme): `backup.run` (file site + DB, tag `pre-wp-update`) → bật bảo trì → `wp.update` → `wp core verify-checksums` + `http.check` (200, không chuỗi `Fatal error`) → lỗi thì restore snapshot (file + DB), tắt bảo trì, ghi `rolled_back` + lỗi. Mỗi lần ghi `wordpress_updates` (mục, bước, snapshot, lỗi).
4. **Tự cập nhật:** `auto_update` off/minor/all trong cửa sổ giờ `HH:00-HH:00` (giờ server), cùng quy trình an toàn.
5. **Staging:** website mới `<subdomain>.<domain>` (tính hạn mức gói), copy file + DB mới, `search-replace` URL, `noindex`, basic auth tùy chọn. Đẩy staging → production: **DEFERRED**.
6. **Hardening:** `DISALLOW_FILE_EDIT`, chặn `xmlrpc.php` và PHP trong `uploads/` ở vhost Nginx, `wp-config.php` 0400, xoay salt (một chiều), ẩn version.
7. **Mật khẩu admin:** step-up; mật khẩu tới agent qua tham chiếu bí mật, không vào params/audit.
8. Quét lỗ hổng plugin: **DEFERRED** (cần chọn nguồn dữ liệu).
