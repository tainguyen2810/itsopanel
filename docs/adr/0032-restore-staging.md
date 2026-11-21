# ADR 0032: Khôi phục qua staging root rồi helper uid account

- **Trạng thái:** Accepted (2026-11-21, duyệt cùng Phase 8)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-85, D-72, D-71

## Bối cảnh

`restic restore` chạy bằng root ghi thẳng vào home do account kiểm soát thì account có thể đặt sẵn symlink (`sites/x/public → /etc`) để root ghi đè file hệ thống.

## Quyết định

1. **Staging:** agent `restic restore <id> --target /var/lib/itso/restore/<restore_uuid> --include <đường dẫn>` (thư mục root 0700, ngoài home, không account nào đọc được). Item kiểu hóa (`BackupRestoreItem`): `files{path}`, `website{site_dir}`, `database{db, target_name}`.
2. **Commit qua helper uid account** (`fsx`, như `fs.upload.commit` ADR 0019): duyệt staging bằng root, mở đích bằng `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` dưới uid account; bỏ setuid/setgid, bỏ thiết bị/FIFO/socket, symlink trong snapshot **không** được tạo lại (bỏ và báo `skipped[]` lý do `symlink`; SA tạo lại thủ công nếu cần), không bao giờ ghi qua symlink có sẵn ở đích; đích luôn là thư mục chưa tồn tại (`backups/restore-<ts>`, `sites/<domain>.restore-<ts>`), giải vào thư mục tạm cạnh bên rồi `renameat2(RENAME_NOREPLACE)`; ghi đè website = `renameat2(RENAME_EXCHANGE)` sau snapshot pre-restore; chủ = account, quyền giữ theo snapshot đã bỏ bit đặc biệt. Mục bị bỏ trả về `skipped[]` với lý do.
3. **Chế độ `new` (mặc định):** file lẻ/thư mục → `backups/restore-<yyyymmdd-hhmmss>/<đường dẫn>`; website → `sites/<domain>.restore-<ts>/`; DB → DB mới `target_name` (`<tên>_r<yyyymmdd>`), tạo dưới danh tính chủ rồi nạp dump. Không đụng bản đang chạy.
4. **Chế độ `overwrite`:** cần step-up (panel) và tạo **snapshot pre-restore** trước (tag `pre-restore`) của đúng phạm vi bị ghi đè; website: commit vào `sites/<domain>.restore-<ts>`, kiểm tra cấu trúc, rồi `renameat2(RENAME_EXCHANGE)` nguyên tử với thư mục đang chạy, bản cũ giữ ở `.restore-<ts>` tới khi SA dọn; reload PHP-FPM pool. DB: dump bản hiện tại vào snapshot pre-restore rồi nạp lại.
5. **Phạm vi:** khôi phục sang account khác cùng máy chủ (nhân bản) được, panel kiểm quyền cả hai account; sang máy chủ khác thuộc Phase 9.
6. Staging bị xóa khi op kết thúc (kể cả lỗi); `itso repair` dọn staging mồ côi cũ hơn 24 giờ.

## Hệ quả

- Không có đường root ghi vào home qua symlink; dung lượng đĩa cần gấp đôi phần khôi phục trong lúc chạy (cảnh báo khi `disk_free` < kích thước khôi phục × 1,2).
- Test với restic thật: symlink đặt sẵn ở đích không bị ghi qua, setuid bị bỏ, sha256 khớp sau khôi phục.
