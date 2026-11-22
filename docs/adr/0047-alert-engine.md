# ADR 0047: Bộ máy cảnh báo

- **Trạng thái:** Accepted (2026-11-22, người dùng chọn bắt đầu Phase 11)
- **Ngày:** 2026-11-22
- **Quyết định liên quan:** D-102, ADR 0046

## Quyết định

1. Lệnh `itso:alerts-evaluate` chạy mỗi phút (scheduler, `withoutOverlapping`), đọc mẫu gần nhất.
2. **Rule:** `metric op threshold` kéo dài `for_sec`, phạm vi `server | hosting_account | website` (`scope_uuid` null = mọi đối tượng cùng loại), mức `low…critical`, kênh, `repeat_sec` (mặc định 4 giờ, 0 = không nhắc).
3. **Trạng thái** `pending → firing → resolved`; khóa trùng bằng `fingerprint` (rule + đối tượng), unique một partial index khi chưa resolved. Resolve có trễ: 2 lượt đánh giá liên tiếp dưới ngưỡng.
4. **Mất kết nối server:** không tiếp xúc agent ≥ 90 giây (theo `last_seen_at` từ metrics-collect/relay) ⇒ firing ngay ở lượt kế tiếp, bỏ qua `for_sec` ⇒ cảnh báo ≤ 2 phút (tiêu chí nghiệm thu).
5. **Rule mặc định** (seed, sửa ngưỡng/kênh/bật tắt được, không xóa được → 409, không đổi metric/phạm vi): server mất kết nối, disk > 90 %, inode > 90 %, RAM > 95 % 10 phút, dịch vụ lõi dừng, uptime down, chứng chỉ ≤ 7 ngày, backup lỗi, quota account ≥ 100 %.
6. **Ack** dừng nhắc lại cho lần firing đó; **silence** 5 phút – 7 ngày, có lý do, audit; cảnh báo vẫn được ghi.
7. **Xem trước** `POST /alert-rules:preview`: đánh giá rule trên mẫu mới nhất, trả số đối tượng khớp.

## Hệ quả

Đơn giản, test được bằng Pest + `travelTo`. Độ trễ tối đa ≈ 1 phút đánh giá + 1 phút thu thập.
