# ADR 0001: Ghi lại quyết định kiến trúc bằng ADR

- **Trạng thái:** Accepted
- **Ngày:** 2026-11-20
- **Quyết định liên quan:** —

## Bối cảnh

Dự án dài nhiều Phase, làm qua nhiều phiên Claude Code. Quyết định dễ bị quên hoặc làm lại nếu chỉ nằm trong chat.

## Quyết định

Dùng ADR theo mẫu MADR trong `docs/adr/NNNN-ten.md`. Mỗi ADR liên kết tới mã D-xx trong `DECISIONS.md`. ADR không bị xóa; khi thay đổi thì tạo ADR mới và đánh dấu ADR cũ là Superseded.

## Hệ quả

- Tích cực: Có lịch sử rõ ràng, phiên mới đọc lại được.
- Đánh đổi: Tốn thêm công viết tài liệu cho mỗi quyết định lớn.
