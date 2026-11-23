# ADR 0058: Offline installer

- **Trạng thái:** Accepted (2026-11-23, người dùng yêu cầu bắt đầu Phase 12; tag cuối Phase chọn trên thẻ quyết định 2026-11-23)
- **Ngày:** 2026-11-23
- **Quyết định liên quan:** D-113, `docs/planning/10-INSTALLER.md`

## Quyết định

1. `make release-offline` tạo `itso-<ver>-offline.tar`: gói release đã ký + danh sách `.deb` phụ thuộc Ubuntu 24.04 amd64 **khóa phiên bản** (`install/offline-packages.lock`, tải khi đóng gói, kiểm sha256) + manifest `offline-manifest.json` (ký Ed25519 cùng khóa release).
2. `install.sh --offline <bundle.tar>`: kiểm chữ ký manifest + sha256 từng `.deb` → dựng apt repo cục bộ tạm (`deb [trusted=yes] file:/var/lib/itso/offline-repo ./`, chỉ tồn tại trong lúc cài, xóa sau) → cài như bình thường, không gọi mạng; ACME tắt mặc định (dùng chứng chỉ tự ký hoặc tải lên).
3. Container CI không tải được `.deb` thật: test bằng bundle giả (danh sách rỗng + manifest ký khóa DEV); cài thật trên VM không mạng: chờ VM.
