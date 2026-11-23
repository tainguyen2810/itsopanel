# ADR 0058: Offline installer

- **Trạng thái:** Accepted (2026-11-23, người dùng yêu cầu bắt đầu Phase 12; tag cuối Phase chọn trên thẻ quyết định 2026-11-23)
- **Ngày:** 2026-11-23
- **Quyết định liên quan:** D-113, `docs/planning/10-INSTALLER.md`

## Quyết định

1. `make release-offline` tạo `itso-<ver>-offline.tar`: gói release đã ký + danh sách `.deb` phụ thuộc Ubuntu 24.04 amd64 **khóa phiên bản** (`install/offline-packages.lock`, tải khi đóng gói, kiểm sha256) + manifest `offline-manifest.json` (ký Ed25519 cùng khóa release).
2. `install.sh --offline <bundle.tar>`: kiểm chữ ký manifest + sha256 từng `.deb` → dựng apt repo cục bộ tạm (`deb [trusted=yes] file:/var/lib/itso/offline-repo ./`, chỉ tồn tại trong lúc cài, xóa sau) → cài như bình thường, không gọi mạng; ACME tắt mặc định (dùng chứng chỉ tự ký hoặc tải lên).
3. Container CI không tải được `.deb` thật: test bằng bundle giả (danh sách rỗng + manifest ký khóa DEV); cài thật trên VM không mạng: chờ VM.

## Hiện thực (Prompt 12.6, 2026-11-23)

- Lock ở `packaging/offline-packages.lock` (cạnh các file đóng gói khác, thay cho `install/` dự kiến), gói gốc ở
  `packaging/offline-packages.list` (gói của `itso install` + stack Wizard: nginx, PHP 8.3, MariaDB, restic). `--update-lock`
  tính bao đóng Depends/Pre-Depends bằng `apt-cache depends --recurse` trên Ubuntu 24.04 và ghi `<gói>=<bản> <sha256> <file>`.
- Chỉ mục apt `Packages` sinh lúc đóng gói (`dpkg-scanpackages`) và nằm trong danh sách sha256 đã ký, nên máy đích không cần
  `dpkg-dev`. Repo tạm được trỏ qua `/etc/apt/itso-offline.list` (ngoài `sources.list.d`); `itso install --offline` gọi apt với
  `Dir::Etc::SourceList` = file đó, `SourceParts=-` — không đọc nguồn mạng nào, không đổi cấu hình apt của máy.
- `--keep-offline-repo`: giữ repo và chuyển danh sách nguồn vào `sources.list.d` để Wizard cài stack web/DB từ bundle.
- ACME tắt bằng `ITSO_ACME_DIRECTORY=disabled` trong `itso.env`; panel trả 409 kèm hướng dẫn tải chứng chỉ lên.
- Bundle bị từ chối trước khi giải nén nếu có mục không phải file/thư mục hoặc tên lạ; sau giải nén kiểm chữ ký, sha256 từng
  file và không có `.deb` ngoài danh sách đã ký.
