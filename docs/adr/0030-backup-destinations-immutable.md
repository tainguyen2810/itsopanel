# ADR 0030: Đích backup local/SFTP/S3/rest, credential chỉ để ghi, forget tắt mặc định

- **Trạng thái:** Accepted (2026-11-21, duyệt cùng Phase 8)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-83, D-19, D-69

## Bối cảnh

D-19: panel bị chiếm không được xóa được backup. Nếu panel giữ credential có quyền xóa ở đích, kẻ chiếm panel xóa sạch backup rồi mã hóa máy chủ.

## Quyết định

1. **Bốn loại đích** (`BackupDestination` kiểu hóa, oneOf theo `type`):
   - `local`: `/var/backups/itso/repos/<path>`, root 0700. Không bất biến, không tính là off-site.
   - `sftp`: `host` (hostname/IP), `port`, `user` (`^[a-z_][a-z0-9_-]{0,31}$`), `path` tuyệt đối. Agent sinh khóa ed25519 riêng cho đích ở `/etc/itso/backup/keys/<dest_uuid>` (0600), trả khóa công khai để SA thêm vào `authorized_keys` máy đích. Lần kiểm tra đầu ghim host key (`host_key_sha256`); sau đó `StrictHostKeyChecking=yes` với `known_hosts` riêng, lệch → `host_key_mismatch`. restic gọi ssh bằng `-o sftp.command` do agent dựng từ trường kiểu hóa (argv, không qua shell).
   - `s3`: `endpoint` HTTPS, `bucket`, `region`, access key; phát hiện Object Lock (`GetObjectLockConfiguration`) khi kiểm tra.
   - `rest`: rest-server HTTPS, user nên là user `--append-only`; phát hiện append-only bằng cách thử xóa một khóa thử.
2. **Chỉ credential ghi:** panel/agent giữ credential đủ để `init/backup/snapshots/ls/restore/check`. Retention ở panel là "mong muốn". Op `backup.forget` rủi ro `critical`, tắt mặc định bằng policy agent (`backup_forget: false` trong `/etc/itso/agent-policy.yaml`); chỉ đổi được bằng `itso policy set backup_forget on` trên máy chủ.
3. **Hai chế độ prune:** `prune=panel` khi đích không bất biến (không append-only, không Object Lock) **và** policy agent bật forget: panel chạy forget theo retention. Ngược lại `prune=cli`: SA chạy `itso backup prune --destination <uuid>` trên máy chủ, nhập credential prune tại chỗ (không lưu, không qua panel). UI hiện badge "Giữ theo CLI" và giải thích.
4. **Kiểm tra đích** (`backup.destination.test`): kết nối, quyền ghi, độ trễ, phát hiện `append_only`/`object_lock_days`, host key; kết quả lưu ở `detected`, `last_check_*`. Không tin cấu hình khai báo khi tính 3-2-1-1-0.
5. **Snapshot bất biến:** snapshot ở đích bất biến có `locked_until` (Object Lock: `taken_at + object_lock_days`; append-only: vô hạn). API từ chối xóa (`409 immutable`), UI ẩn nút xóa.

## Hệ quả

- Ransomware chiếm panel không xóa được bản ở đích append-only/Object Lock; xóa bản ở đích thường vẫn cần policy agent bật.
- SA phải tự chạy prune định kỳ cho đích bất biến (runbook).
- Vector độc: host/user chèn tùy chọn ssh, endpoint không HTTPS, local nhận đường dẫn tự do.
