# ADR 0059: Journal cập nhật và chaos test

- **Trạng thái:** Accepted (2026-11-23, người dùng yêu cầu bắt đầu Phase 12; tag cuối Phase chọn trên thẻ quyết định 2026-11-23)
- **Ngày:** 2026-11-23
- **Quyết định liên quan:** D-114, D-65 (update ký + rollback)

## Quyết định

1. `itso update` ghi **journal** `/var/lib/itso/update.journal` (JSON, fsync sau mỗi bước, ghi tạm rồi rename): `version_from`, `version_to`, `step` ∈ `downloaded → verified → extracted → migrated → switched → restarted`, `started_at`.
2. Khởi động sau sự cố (kill -9, mất điện): `itso doctor` báo journal dở; `itso repair --fix` quyết định theo bước: trước `migrated` → xóa bản giải nén dở, giữ bản cũ; `migrated`/`switched` → hoàn tất (migration chỉ thêm — expand/contract) hoặc quay lại nếu health check lỗi; `restarted` → chỉ kiểm sức khỏe. Xóa journal khi xong; ghi lịch sử vào `/var/lib/itso/update-history.jsonl` (panel đọc qua `/system/updates`).
3. Manifest có `breaking_db`; khi true phải backup panel trước, rollback qua bản backup.
4. Kiểm: Go test giả lập crash ở từng bước bằng Runner giả; `tests/vm/upgrade-loop.sh` 20 vòng update → kiểm → rollback → update, chaos `kill -9` và `sysrq b` ở từng bước, đo 0 lỗi HTTP ở site account (chờ VM).
