# Kế hoạch Laravel migrations

Phase 1 chỉ có **đặc tả** (DBML + SQL + test). Laravel migrations có từ Phase 3, mỗi Phase chỉ tạo bảng mình dùng. Đặc tả DBML luôn là đích; migration của từng Phase phải khớp phần tương ứng (kiểm bằng so sánh `pg_dump --schema-only` với `itso.sql` + `extras.sql` ở Phase 12).

## 1. Bảng theo Phase

| Phase | Bảng | Số bảng |
|---|---|---|
| 3 — Auth, RBAC, jobs, audit | `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `user_scopes`, `mfa_credentials`, `sessions`, `api_tokens`, `login_attempts`, `ip_allowlist`, `impersonation_sessions`, `tos_acceptances`, `servers`, `agents`, `hosting_packages`, `hosting_package_versions`, `hosting_accounts`, `account_lifecycle_events`, `uid_allocations`, `jobs`, `job_steps`, `job_logs`, `audit_logs`, `notifications`, `settings` | 26 |
| 4 — Server, phần mềm, quota | `server_services`, `server_capacity`, `software_catalog`, `server_software`, `account_usage_snapshots`, `metric_samples` | 6 |
| 5 — Website, SSL, DNS | `websites`, `domains`, `website_settings`, `acme_accounts`, `certificates`, `php_versions`, `dns_providers`, `dns_zones`, `dns_records` | 9 |
| 6 — DB, SFTP, cron, file, terminal | `databases`, `database_users`, `database_grants`, `sftp_accounts`, `ssh_keys`, `cron_jobs`, `cron_runs`, `upload_sessions`, `file_operations`, `terminal_sessions` | 10 |
| 7 — Bảo mật | `security_events`, `firewall_rules`, `malware_scans`, `malware_findings`, `quarantine_items`, `fim_baselines`, `firewall_applies`, `security_settings`, `waf_settings`, `waf_events` (partition tháng), `fim_changes`, `terminal_recordings` | 6 |
| 8 — Backup, purge | `backup_destinations`, `backup_repositories`, `backup_policies`, `backup_policy_destinations`, `backup_jobs`, `backup_snapshots`, `backup_verifications`, `restore_jobs`, `purge_records` | 7 |
| 9 — Multi-server, chuyển account | `agent_enrollment_tokens`, `account_migrations` | 2 |
| 10 — Docker, WordPress, Software | `docker_hosts`, `registries`, `compose_projects`, `compose_revisions`, `containers`, `port_allocations`, `image_rollbacks`, `wordpress_sites`, `wordpress_components`, `wordpress_updates`, `git_repositories`, `git_deployments` (+ ALTER `software_catalog`, `server_software`, `websites`, `backup_policies`, `backup_snapshots`) | 12 |
| 11 — Giám sát, cảnh báo | `metric_rollups`, `alert_rules`, `alerts`, `uptime_checks`, `notification_channels`, `notification_preferences` | 6 |
| **Tổng** | | **84** |

Prompt 7.4 bổ sung cột mà API Security Center cần (migration Phase 7 chưa phát hành nên sinh lại, không viết migration mới): `uuid` cho `security_events`, `firewall_rules`, `malware_scans`, `malware_findings`, `quarantine_items`, `waf_events` (không unique vì là bảng partition); `security_events.message`, `acknowledged_at`; `firewall_rules.direction`, `enabled`; `malware_scans.target`, `engines`; `malware_findings.sha256`, `size`, `found_at`; `quarantine_items.signature`, `size`; CHECK direction/protocol/priority, engine/action/sha256.

Phần trong `extras.sql` đi cùng bảng của nó: trigger realm (Phase 3), audit append-only + hash chain + partition (Phase 3), package version bất biến (Phase 3), purge guard (Phase 8, khi có `purge_records`), partition `metric_samples` (Phase 4).

FK tới bảng của Phase sau (ví dụ `hosting_accounts.last_job_id → jobs` cùng Phase 3 thì tạo luôn; `audit_logs.server_id` cũng vậy). FK tới bảng chưa tồn tại được thêm bằng migration riêng ở Phase tạo bảng đích.

## 1b. Sinh migration từ đặc tả (từ Phase 3)

`make db-migrations PHASE=N` (`database/tools/gen_migrations.py`) ghi `apps/api/database/migrations/2026_11_20_00000N_phase_N_schema.php`: migration chứa nguyên văn các câu lệnh của `itso.sql` + `extras.sql` mà mọi bảng nó nhắc tới thuộc Phase ≤ N và chưa có ở Phase trước (FK tới bảng Phase sau được thêm ở Phase đó). `make db-verify` kiểm:

- file migration đã commit khớp đặc tả (`--check`);
- áp lần lượt SQL Phase 3 → 11 vào database rỗng cho ra **đúng** schema của `itso.sql` + `extras.sql` (so `pg_dump --schema-only`).

Migration đã phát hành không sinh lại; thay đổi schema sau `v0.1.0-alpha` theo expand/contract bằng migration mới viết tay.

## 2. Nguyên tắc expand / contract

Áp dụng từ Phase 3 và bắt buộc từ v0.1.0-alpha (đã có dữ liệu thật):

1. **Expand:** chỉ thêm (bảng, cột nullable hoặc có default, index `CONCURRENTLY`). Code mới ghi cả cột cũ và mới.
2. **Backfill:** job nền theo lô, có thể chạy lại, không khóa bảng lâu.
3. **Switch:** code đọc cột mới; theo dõi một bản phát hành.
4. **Contract:** xóa cột/bảng cũ ở bản phát hành **sau** đó, kèm backup trước khi chạy.

Quy tắc:

- Không sửa migration đã phát hành; luôn thêm migration mới.
- Không đổi tên cột trực tiếp; dùng expand/contract.
- Thêm CHECK/FK cho bảng lớn: `NOT VALID` rồi `VALIDATE CONSTRAINT` riêng.
- Mỗi migration có `down()` hoặc ghi rõ lý do không đảo được; `itso update` tự backup database trước khi migrate (ARCHITECTURE.md, quy trình cập nhật an toàn).
- CI chạy `migrate:fresh` + test SQL ở `database/tests/` trên PostgreSQL 16 cho mọi PR có migration.

## 3. Partition

- `audit_logs`: partition theo tháng, khóa chính `(id, at)`. Scheduler gọi `itso_ensure_audit_partition(date)` cho tháng hiện tại và tháng sau. Partition mặc định `audit_logs_default` tránh mất bản ghi.
- `metric_samples`: partition theo ngày qua `itso_ensure_metric_partition(date)`; giữ 14 ngày, sau đó chỉ còn `metric_rollups`. Xóa dữ liệu cũ bằng `DROP TABLE` partition, không `DELETE`.
- Lưu ý: tạo partition cho khoảng thời gian đã có bản ghi trong partition mặc định sẽ lỗi; scheduler phải tạo trước (luôn tạo trước 1 kỳ).
