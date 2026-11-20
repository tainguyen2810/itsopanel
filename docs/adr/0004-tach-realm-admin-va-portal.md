# ADR 0004: Tách realm admin và portal

- **Trạng thái:** Accepted
- **Ngày:** 2026-11-20
- **Quyết định liên quan:** D-25, D-40

## Bối cảnh

Admin Panel là khu riêng tư; User Hosting Portal truy cập từ Internet. Lỗi phân quyền không được phép biến USER thành admin.

## Quyết định

Một bảng `users` có cột `realm` (`admin` hoặc `portal`) không đổi được sau khi tạo (trigger DB). SUPER_ADMIN/ADMIN chỉ thuộc realm admin, USER chỉ thuộc realm portal (CHECK). Hai Laravel guard, hai origin (`admin.<domain>`, `my.<domain>`), cookie riêng, route riêng `/api/v1/admin/*` và `/api/v1/portal/*`. Admin chỉ truy cập từ IP allowlist/VPN, MFA bắt buộc.

## Hệ quả

- Tích cực: Ranh giới rõ ở DB, guard, origin và mạng.
- Đánh đổi: Nhân viên muốn xem như USER phải dùng impersonate có lý do và audit.
