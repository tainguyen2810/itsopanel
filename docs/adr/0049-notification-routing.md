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
