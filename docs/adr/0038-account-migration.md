# ADR 0038: Chuyển account giữa server qua repo restic

- **Trạng thái:** Accepted (2026-11-21, duyệt cùng kế hoạch Phase 9)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-93, D-82…D-85 (backup), D-46 (purge), D-48 (kế hoạch ban đầu)

## Quyết định

1. **Dữ liệu đi qua repo restic của account** (Phase 8), không có kênh rsync/ssh trực tiếp giữa hai node và không op nào nhận host/đường dẫn tự do. Đích đọc cùng repo bằng mật khẩu repo (tham chiếu bí mật).
2. **Máy trạng thái** (`account_migrations.state`): `preflight → syncing → verifying → cutover → holding → completed`, nhánh `rolled_back` / `failed`. Mỗi account chỉ một lần chuyển chưa kết thúc (unique index một phần).
   - **Kiểm tra trước** (`POST /hosting-accounts/{id}:migrate-preflight`, không đổi gì; op `migrate.preflight` trên đích): agent đích trực tuyến, nhận account, đủ đĩa (+10 % dự phòng), UID/username trống, đủ PHP/DB, đọc được repo. Mục `block` chặn bắt đầu.
   - **Đồng bộ lượt đầu** (job `hosting_account.migrate`): `migrate.preflight` → `account.ensure` ở đích (giữ UID nếu trống) → `backup.run` ở nguồn (tag `migration`) → `backup.restore` ở đích → `migrate.verify` ở đích: sha256 file theo manifest, số bảng/số dòng + checksum từng DB, HTTP qua `http.check` (Host header, 127.0.0.1 của node, đường dẫn tương đối), SSL, cron, UID.
   - **Cutover** (SUPER_ADMIN, gõ username): `migrate.cutover role=source` (khóa account: dừng PHP-FPM/cron/SFTP) → `backup.run` lượt cuối → `backup.restore` ở đích → `migrate.verify` → `migrate.cutover role=target` (bật pool/vhost/cron/SFTP) → `http.check` → đổi DNS nếu zone do panel quản lý (bước panel `dns.records.apply`), nếu không hiển thị bản ghi cần đổi tay. Đo downtime thực tế.
   - **Giữ nguồn** (`holding`): account chạy ở đích; bản ở nguồn bị khóa, giữ `keep_source_days` (1–30, mặc định 7) tới `cleanup_after`. Rollback vẫn được: `migrate.rollback role=target` + `role=source`, đổi DNS về.
   - **Dọn nguồn** (`POST /account-migrations/{id}:cleanup` hoặc tới hạn): op `account.remove` ở nguồn với `reason=migrated`, `ref_uuid` = migration, `final_snapshot_id` của lượt cuối, `confirm=true` + `confirm_username` khớp. Sau bước này hết rollback.
3. **Khôi phục sang server khác** dùng cùng cơ chế: `POST /restores` với `target_server_uuid` (chỉ Admin, chỉ ra bản mới): `account.ensure` + `backup.restore` ở đích.

## Hệ quả

- Tái dùng mã đã kiểm của Phase 8 (staging root 0700, helper uid account, bỏ symlink/setuid) cho dữ liệu chuyển.
- Thời gian sync lượt đầu phụ thuộc đích backup; lượt cuối chỉ là phần chênh lệch nên downtime ngắn.
- Kiểm thử thật (2 node, dữ liệu MariaDB thật, đo downtime) chạy ở `tests/vm/phase9.sh` (3 VM, chờ VM).
