# ADR 0010: Git local trước, GitHub sau

- **Trạng thái:** Accepted
- **Ngày:** 2026-11-20
- **Quyết định liên quan:** D-51

## Bối cảnh

Chưa có repository GitHub; không muốn chặn tiến độ.

## Quyết định

Khởi tạo Git local, làm trên nhánh `phase-<N>`. Bản sao repo và file bundle được lưu sau mỗi prompt. Kết nối GitHub theo `docs/runbooks/connect-github.md` (Prompt 1.7) khi người dùng yêu cầu; không tự tạo remote.

## Hệ quả

- Tích cực: Bắt đầu ngay.
- Đánh đổi: CI GitHub Actions chỉ chạy sau khi có remote; trước đó dùng `make check` local.
