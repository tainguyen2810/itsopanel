# ADR 0037: Job khi node mất kết nối và gợi ý server

- **Trạng thái:** Accepted (2026-11-21, duyệt cùng kế hoạch Phase 9)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-91, D-92, D-42

## Quyết định

1. **Trạng thái kết nối** (`agents.connection`): heartbeat qua relay mỗi 20 giây. Quá 60 giây (3 nhịp) → `degraded`; quá 5 phút → `unreachable` + thông báo SUPER_ADMIN; chưa từng kết nối → `pending`; bị thu hồi → `revoked`. Agent local giữ quy tắc Phase 4 (cửa sổ `connected_window_sec`).
2. **Job tới node không kết nối** chuyển `waiting_agent` (trạng thái job mới), đặt `jobs.agent_deadline_at`: 30 phút cho op ghi, 2 phút cho op đọc. Node kết nối lại → job tiếp tục, gửi lại với cùng op_id (agent trả kết quả đã lưu nếu op đã chạy). Quá hạn → job `failed` với lỗi `agent_unreachable`, không thay đổi gì. Không tự chuyển account khỏi node chết.
3. **Gợi ý server** (`GET /placement/suggestions`): lọc server có role `web`, đang nhận account, trạng thái `ready`, kết nối `online`, đủ phiên bản PHP/DB của gói, đĩa còn ≥ 15 % sau khi cấp; xếp theo điểm từ tài nguyên trống và **% cam kết** (tổng hạn mức đĩa các account / dung lượng đĩa). Server bị loại vẫn trả về với `eligible=false` và `excluded_reasons`. Chỉ gợi ý, admin chọn; không tự đặt.

## Hệ quả

- UI hiển thị banner "mất kết nối" trên server, job "chờ node", và lý do loại server.
- Không có hàng đợi tách theo node trong Redis: JobRunner lọc theo trạng thái kết nối trước khi gửi op, đủ cho quy mô nội bộ (hàng chục node).
