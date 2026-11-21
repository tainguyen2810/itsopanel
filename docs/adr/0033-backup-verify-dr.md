# ADR 0033: Lịch, quota backup, kiểm chứng 3-2-1-1-0 và khôi phục thảm họa

- **Trạng thái:** Proposed (chờ duyệt cùng Phase 8)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-86, D-87, D-46, D-15

## Quyết định

1. **Lịch trong panel:** `itso:backup-due` chạy mỗi 5 phút, chọn policy có `next_run_at ≤ now`, tạo job theo từng repo với jitter ổn định theo repo (0–20 phút) để không đồng loạt. Mặc định: file hằng ngày 02:00, DB mỗi 6 giờ, cấu hình + panel hằng ngày. Một tác vụ một repo (khóa Redis `backup:repo:<uuid>` + khóa restic; trùng → `repo_locked`, retry sau).
2. **Quota backup theo gói:** `hosting_packages.backup_quota_mb`; dung lượng repo account = `restic stats --mode raw-data` (op `backup.stats`, sau mỗi lần backup). > 100 % → `quota_state=warn` + thông báo; > 120 % → `paused`: lịch bỏ qua repo, backup tay trả `409 quota_exceeded`; không bao giờ tự xóa snapshot.
3. **Kiểm chứng:** hằng tuần `backup.check` với `read_data_percent=5` mỗi repo; hằng tháng `backup.restore_test` cho mỗi account: khôi phục vào staging tối đa 200 file mẫu + 1 DB, so sha256 với manifest trong `itso-meta.json`, DB nạp vào DB tạm rồi xóa. Kết quả lưu `backup_verifications`; snapshot qua restore test có `verified_at`.
4. **3-2-1-1-0 tính từ dữ kiện thật** (`GET /backups/overview`): `copies` ≥ 3 (bản sống + số đích có snapshot ≤ 48 giờ), `media` ≥ 2 loại đích, `offsite` ≥ 1 đích không phải `local`, `immutable` ≥ 1 đích phát hiện append-only/Object Lock, `errors` = 0 lỗi ở lần kiểm chứng gần nhất của mọi repo (và có kiểm chứng ≤ 35 ngày). Mỗi luật trượt có `reason`.
5. **Purge (D-46):** trước khi purge, panel tạo snapshot `final` và chạy restore test trên nó; chỉ khi thành công mới đặt `purge_records.backup_verified_at` (trigger DB đã chặn purge thiếu điều kiện này).
6. **Khôi phục thảm họa:** `install.sh --restore` cài panel trống ở chế độ khôi phục (mã thiết lập mang `mode: restore`); wizard nhập đích + đường dẫn và mật khẩu repo server + khóa riêng age → `POST /setup/restore:inspect` (agent `backup.snapshots` tag `type:panel`, gọi đồng bộ, không lưu gì) → chọn bản → `POST /setup/restore` (job `setup.restore`, op `panel.restore`: tải + giải mã age vào staging root 0700, hẹn unit tạm) → `itso panel-restore-apply`: sao lưu trạng thái máy mới, `pg_restore --single-transaction` DB panel, `/etc/itso` (giữ `itso.env`/`agent.key`/`redis.conf`/`panel.json`/`tls` của máy mới, chỉ lấy `APP_KEY` cũ), migrate, `itso:reconcile` áp lại desired state, `itso:dr-restore --start` khôi phục dữ liệu từng account (ghi đè, song song tối đa 2, scheduler 5 phút). Khóa riêng và mật khẩu của job nằm tạm trong Redis (Crypt bằng APP_KEY máy mới, TTL 2 giờ), tới agent qua tham chiếu `setup_restore:<uuid>/<khóa>`, bị xóa khi job kết thúc; không ghi DB, job_steps, log hay audit. Runbook `docs/runbooks/disaster-recovery.md`; diễn tập trên 2 VM là tiêu chí nghiệm thu (chờ VM).

## Hệ quả

- Tải máy do backup bị giới hạn bởi slice `itso-maint`; quota minh bạch cho khách.
- "0 lỗi" chỉ xanh khi có kiểm chứng thật gần đây, không suy ra từ việc backup chạy xong.
