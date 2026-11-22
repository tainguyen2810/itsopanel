# ADR 0049: Định tuyến thông báo

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 11)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-104, ADR 0048

## Quyết định

1. **Danh mục sự kiện ở code** (`GET /notification-events`): `type`, nhóm, mức mặc định, đối tượng nhận (`super_admin`, `admin` trong phạm vi server/account, `user` chủ account), kênh cho phép, `in_app_locked` (mức critical: in-app luôn bật).
2. `notification_preferences` theo người × sự kiện × kênh.
3. **USER** chỉ có in-app và email của chính mình (email đã xác minh). Telegram và webhook là kênh realm admin, gắn vào rule cảnh báo hoặc sự kiện. Portal chỉ thấy sự kiện có `user` trong đối tượng.
4. Sự kiện USER: quota 80 %/100 %, chứng chỉ sắp hết hạn/gia hạn lỗi, backup lỗi, account bị khóa/mở, website down/up, WordPress cập nhật bị hoàn tác.
5. Nội dung không chứa bí mật; link về trang liên quan theo realm.

## Ghi chú hiện thực (11.5)

- Email "đã xác minh": USER không tự đổi email (Portal profile chỉ sửa tên/ngôn ngữ/múi giờ), email do quản trị viên đặt khi tạo tài khoản nên coi là đã xác minh; người dùng không `active` không nhận email.
- Tùy chọn mặc định: chỉ in-app; người nhận tự bật email. Dòng `event_type = '*'` lưu kênh đang bật chung.
- Telegram trong tùy chọn của quản trị viên: sự kiện được gửi một lần tới các kênh Telegram đang bật (khử trùng lặp theo kênh + loại + tiêu đề trong 1 phút). Cảnh báo rule đi tới kênh theo loại trong `channels` của rule.
- USER nhận sự kiện nghiệp vụ (website.down/up, quota.*, certificate.*, backup.failed, account.*, wordpress.*), không nhận cảnh báo rule (`alert.*` chỉ realm admin).
