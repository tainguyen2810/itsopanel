# ADR 0006: Vòng đời account và purge sau 30 ngày

- **Trạng thái:** Accepted
- **Ngày:** 2026-11-20
- **Quyết định liên quan:** D-46

## Bối cảnh

Xóa nhầm dữ liệu hosting là không khôi phục được. Cần thời gian giữ dữ liệu và kiểm soát chặt trước khi xóa vĩnh viễn.

## Quyết định

Terminate giữ dữ liệu 30 ngày. Trước purge bắt buộc: cảnh báo người dùng và admin (lúc terminate, T-7, T-1); audit mọi bước; xác minh backup cuối hợp lệ (`restic check` + restore thử vào sandbox); vẫn khôi phục được tới lúc purge. Purge 2 bước (lên lịch, xác nhận), sinh biên bản `purge_records`. `legal_hold` chặn purge.

## Hệ quả

- Tích cực: An toàn dữ liệu cao.
- Đánh đổi: Chiếm dung lượng thêm 30 ngày cho account đã xóa.
