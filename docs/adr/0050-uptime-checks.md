# ADR 0050: Uptime check theo website

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 11)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-105, ADR 0047

## Quyết định

1. Uptime check gắn với **một website**; chỉ nhập **đường dẫn** (`/health`), URL ghép từ domain chính của website ⇒ không có URL tùy ý, không SSRF.
2. Chạy bằng op agent mới `uptime.probe` trên **server chứa website**: lô ≤ 50 URL, timeout ≤ 10 giây/URL, không proxy, không theo redirect sang host khác, đọc hạn chứng chỉ TLS, khớp từ khóa trong 64 KB đầu body, song song có giới hạn.
3. `interval_sec` 60–3600. Down = 3 lần lỗi liên tiếp; up lại sau 1 lần thành công. Bảng `uptime_results` (partition ngày, giữ 7 ngày); % uptime 24h/7d/30d tính từ kết quả và rollup.
4. SA/ADMIN (theo phạm vi) tạo/sửa/xóa; USER chủ website xem và bật/tắt.
5. Giới hạn đã biết: kiểm từ một điểm (chính server), không phát hiện sự cố mạng phía ngoài.
