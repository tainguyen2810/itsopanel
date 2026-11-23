# ADR 0055: Đánh giá Row-Level Security PostgreSQL

- **Trạng thái:** Accepted (2026-11-23, người dùng yêu cầu bắt đầu Phase 12; tag cuối Phase chọn trên thẻ quyết định 2026-11-23)
- **Ngày:** 2026-11-23
- **Quyết định liên quan:** D-110, D-02 (phạm vi ở tầng ứng dụng)

## Bối cảnh

Phạm vi dữ liệu (USER chỉ thấy account mình, ADMIN theo server/account được giao) đang làm ở tầng ứng dụng (`Access::*`). RLS của PostgreSQL là lớp phòng thủ thứ hai nếu có lỗi ở code.

## Đánh giá

- Panel, worker, scheduler, migration dùng **chung một DB role**; job runner và scheduler chạy không có người dùng (cần bypass), migration cần quyền chủ bảng. RLS đòi `SET LOCAL itso.user_id` trong mọi transaction và chính sách cho từng bảng phạm vi account (≈ 25 bảng).
- Rủi ro: quên `SET LOCAL` trong job → truy vấn trả rỗng (lỗi im lặng), hoặc dùng role `BYPASSRLS` cho worker → mất tác dụng phần lớn. Chi phí đo trên bảng `websites` (seed 600 dòng, 12.5): chính sách đơn giản thêm ~0,1–0,3 ms/truy vấn, không đáng kể; chi phí thật nằm ở độ phức tạp vận hành.

## Quyết định

1. **Không bật RLS ở v1.0.** Giữ phạm vi ở tầng ứng dụng.
2. Thêm lưới an toàn tự động (12.4): test **ma trận quyền sinh từ `route:list`** — mọi route admin/portal có `{id}` được gọi bằng actor ngoài phạm vi phải trả 404/403; route ghi thiếu middleware quyền làm test đỏ.
3. Xem lại khi có nhiều DB role tách biệt (panel/worker) hoặc khi mở cho khách ngoài (cùng thời điểm pentest D-50).
