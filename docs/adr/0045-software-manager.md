# ADR 0045: Software Manager

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 10)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-100, D-68 (recipe), D-94

## Quyết định

1. **Catalog trong agent** là nguồn sự thật (op `software.catalog`): mỗi recipe có gói apt, kho, dịch vụ systemd, nhóm, xung đột, phụ thuộc, có phải thành phần lõi. Panel seed bảng `software_catalog` từ op này; `software.status` trả phiên bản cài/mới nhất.
2. **Recipe Phase 10:** `redis` (Ubuntu), `valkey` (xung đột `redis`), `memcached`, `nodejs` (Ubuntu 24.04), `composer`, `wp-cli`, `docker`, PHP 8.1/8.2/8.4.
3. **PPA ondrej/php:** khóa ký ghim fingerprint trong agent, file kho `signed-by` riêng, chỉ bật khi SA cài một bản PHP cần PPA; không đụng nguồn apt khác.
4. **Chặn:** cài khi xung đột → 409 `conflict`; thiếu phụ thuộc → 422; gỡ thành phần lõi hoặc đang dùng (PHP có site/pool, Docker có project, Redis có site dùng) → 409 `resource_locked` kèm lý do (`remove_blocked`).
5. **Nâng cấp:** `software.upgrade` = `apt-get install --only-upgrade <gói của recipe>`.
6. **Cập nhật bảo mật OS:** `os.auto_updates` bật/tắt unattended-upgrades (chỉ bảo mật hoặc tất cả), luôn `Automatic-Reboot "false"`.
