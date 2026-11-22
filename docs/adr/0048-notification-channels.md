# ADR 0048: Kênh thông báo và chặn SSRF

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 11)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-103

## Quyết định

1. Bảng `notification_channels` (email, telegram, webhook), chỉ SA quản lý. Bí mật (bot token, webhook secret) lưu `Crypt`, **chỉ ghi**: API chỉ trả `secret_set`. SMTP cấu hình ở Settings.
2. **Webhook:** chỉ `https://`; `http://` chỉ khi SA bật `allow_private_network` cho kênh đó (có cảnh báo trên UI). Body JSON, header `X-ITSO-Timestamp` và `X-ITSO-Signature: sha256=HMAC(secret, timestamp + "." + body)`.
3. **SSRF guard** khi gửi: phân giải DNS trước, kết nối đúng IP đã kiểm (chống DNS rebinding); luôn từ chối loopback, link-local, metadata `169.254.0.0/16`, `0.0.0.0/8`, multicast; dải riêng (10/8, 172.16/12, 192.168/16, fc00::/7) chỉ khi `allow_private_network`; không theo redirect; timeout 5 giây; đọc phản hồi ≤ 64 KB. Bị chặn → delivery `blocked`, không thử lại.
4. Gửi qua queue `notifications`, thử lại 3 lần (1/5/15 phút); bảng `notification_deliveries` (state `queued|sending|sent|retrying|failed|blocked`, lỗi rút gọn, số lần thử, lần thử kế tiếp); gửi lại thủ công cho `failed|blocked`.
5. Giới hạn 30 tin/phút/kênh, phần vượt gộp thành một tin tóm tắt. Nút "Gửi thử".

## Hệ quả

Laravel gọi mạng từ queue worker (không phải lệnh hệ thống, được phép). Nội dung không chứa bí mật.
