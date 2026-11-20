# ADR 0008: Chuyển Hosting Account giữa các server

- **Trạng thái:** Accepted
- **Ngày:** 2026-11-20
- **Quyết định liên quan:** D-48

## Bối cảnh

Quản lý nhiều server cần cân bằng tải và thay server mà không mất dữ liệu.

## Quyết định

Job `account.migrate` (Phase 9): preflight, tạo account ở đích, sync file và DB, sao chép SSL, cron, cấu hình nginx/php/sftp, ownership/UID, kiểm tra dữ liệu (checksum file, row count + checksum bảng, HTTP check), cutover, giữ nguồn N ngày, dọn dẹp. Rollback được ở mọi bước trước dọn dẹp.

## Hệ quả

- Tích cực: Linh hoạt vận hành.
- Đánh đổi: Phức tạp; downtime ngắn khi cutover.
