# DATABASE — ITSO Panel (phạm vi nội bộ, chốt 2026-11-20)

> Thiết kế đầy đủ ở `docs/planning/04-DATABASE.md` (quy ước, desired/observed, index, migrations), vẫn còn hiệu lực. File này ghi **các thay đổi** cho phạm vi nội bộ.

## 0. Đặc tả chính thức (Prompt 1.3)

| Nội dung | File |
|---|---|
| Schema DBML (81 bảng, nguồn sự thật) | [database/schema/itso.dbml](database/schema/itso.dbml) |
| SQL PostgreSQL 16 sinh ra | [database/schema/itso.sql](database/schema/itso.sql) |
| CHECK, partial unique, trigger, partition | [database/schema/extras.sql](database/schema/extras.sql) |
| ERD toàn bộ / theo nhóm | [erd-full.svg](database/docs/erd/erd-full.svg) · [erd-hosting.svg](database/docs/erd/erd-hosting.svg) · [các nhóm khác](database/docs/README.md) |
| Ownership và phạm vi | [database/docs/ownership.md](database/docs/ownership.md) |
| Vòng đời account, purge D-46 | [database/docs/lifecycle.md](database/docs/lifecycle.md) |
| Kế hoạch migrations | [database/docs/migration-plan.md](database/docs/migration-plan.md) |
| Kiểm chứng | `make db-verify` (`scripts/db-verify.sh`, test ở `database/tests/`) |

Khi bảng dưới đây khác đặc tả, **đặc tả DBML + extras.sql là chuẩn**.

## 1. Giữ nguyên từ 04

- Quy ước: `id` identity + `uuid` (UUIDv7) public; secret mã hóa bằng libsodium; JSONB có schema; soft-delete cho tài nguyên người dùng.
- Desired/Observed: `spec_version`, `observed_version`, `status`, `observed_facts`, `drift`, `observed_at`, `last_job_id`.
- Nhóm bảng: identity (`users`, `roles`, `permissions`, `user_scopes`, `mfa_credentials`, `sessions`, `api_tokens`, `login_attempts`, `ip_allowlist`); infrastructure (`servers`, `agents`, `server_services`, `software_catalog`, `server_software`, `php_versions`); hosting (`hosting_packages`, `hosting_accounts`, `websites`, `domains`, `website_settings`, `certificates`, `databases`, `database_users`, `database_grants`, `sftp_accounts`, `ssh_keys`, `cron_jobs`, `cron_runs`, `dns_*`); docker; backup; jobs; security/audit/notifications/settings/metrics.
- `server_id` có trên mọi tài nguyên ngay từ đầu (multi-server).

## 2. Thay đổi / bổ sung

| Bảng | Thay đổi | Lý do |
|---|---|---|
| `users` | Thêm `realm text check (realm in ('admin','portal'))`, **không đổi được sau khi tạo** (trigger chặn update). Role SUPER_ADMIN/ADMIN chỉ thuộc realm `admin`; USER chỉ thuộc realm `portal` (CHECK + trigger) | Tách hai bề mặt đăng nhập mà vẫn dùng một bảng |
| `hosting_packages` | Chỉ giữ định danh gói (`code`, `name`, `current_version`, `is_active`); mọi giới hạn nằm ở `hosting_package_versions` | Đổi gói có kiểm soát, account trỏ tới phiên bản |
| `hosting_package_versions` (mới) | `package_id`, `version`, toàn bộ giới hạn là cột riêng (disk, inode, CPU, RAM, tasks, PHP workers, IO, số website/domain/DB/FTP/cron, backup), `retention_days_after_terminate ≥ 30`; bất biến (trigger) | Đổi gói có kiểm soát |
| `hosting_accounts` | Thêm `package_version_id`, `lifecycle_state` (pending/provisioning/active/suspended/migrating/terminated/purged/failed), `suspended_reason`, `terminated_at`, `purge_after`, `legal_hold bool`, `migrated_from_account_id` | Vòng đời nội bộ + chuyển server |
| `account_lifecycle_events` (mới) | `hosting_account_id`, `from_state`, `to_state`, `reason`, `actor_user_id`, `job_id`, `at` | Lịch sử khóa/mở/chuyển/xóa |
| `account_migrations` (mới) | `hosting_account_id`, `source_server_id`, `target_server_id`, `target_account_id`, `state` (preflight/syncing/verifying/cutover/completed/rolled_back/failed), `verification jsonb`, `bytes_synced`, `downtime_sec`, `job_id`, `cleanup_after` | Chuyển tài khoản giữa server |
| `server_capacity` (mới) | `server_id` PK, `cpu_cores`, `ram_mb`, `disk_mb`, `allocated_cpu_pct`, `allocated_ram_mb`, `allocated_disk_mb`, `account_count`, `max_accounts`, `accepting_new bool`, `updated_at` | Gợi ý server khi tạo account, khóa khi cấp |
| `uid_allocations` (mới) | `server_id`, `uid`, `hosting_account_id`, `released_at` — unique(server_id, uid) | Không tái dùng UID trong 90 ngày |
| `purge_records` (mới) | `hosting_account_id`, `requested_by_user_id`, `confirmed_by_user_id` (khác người yêu cầu), `final_backup_snapshot_id`, `backup_verified_at`, `objects jsonb` (đường dẫn, DB, repo, hash), `scheduled_for`, `completed_at`; trigger `hosting_purge_guard` | Biên bản xóa (D-46) |
| `backup_destinations` / `backup_repositories` (mới, Phase 8) / `backup_snapshots` | Đích chỉ giữ cấu hình + credential ghi, kết quả kiểm tra, host key, xác nhận bộ khôi phục; repo = đích × máy chủ × account (hoặc × máy chủ) với mật khẩu restic riêng mã hóa, đường dẫn cố định `itso/<server>/acct-<account>`; snapshot gắn repo, website, DB, `locked_until`; `backup_policy_destinations` cho policy nhiều đích (D-23, D-82, ADR 0029) | Backup theo tài khoản, xóa sạch một account được |
| `impersonation_sessions` (mới) | `staff_user_id`, `target_user_id`, `reason`, `started_at`, `ended_at` | Kiểm soát truy cập dữ liệu USER |
| `tos_acceptances` (tùy chọn) | `user_id`, `version`, `accepted_at` | Quy định sử dụng nội bộ cho USER portal |

## 3. Không tạo (DEFERRED / OUT OF SCOPE)

`customers`, `customer_users`, `hosting_services`, `subscriptions`, `service_lifecycle_events` (thay bằng `account_lifecycle_events`), `integration_clients`, `outbox_events` cho webhook bán hàng, `capacity_reservations`/`placement_decisions` (thay bằng gợi ý + khóa trên `server_capacity`), `abuse_cases`, mọi bảng order/invoice/payment. Thiết kế tham khảo vẫn giữ trong `15-HOSTING-PROVIDER.md`.

## 4. Ownership

`hosting_accounts.owner_user_id` → `users` (realm portal). ADMIN thấy account qua `user_scopes` (server hoặc account được giao). Mọi tài nguyên con mang `hosting_account_id`. Query ở portal luôn có global scope `owner_user_id = auth()->id()`, kèm test ma trận quyền. RLS PostgreSQL được đánh giá ở Phase 12.

## 5. Migrations theo Phase

Chi tiết đầy đủ 81 bảng và nguyên tắc expand/contract: [database/docs/migration-plan.md](database/docs/migration-plan.md).

| Phase | Bảng |
|---|---|
| 3 | identity, `servers`, `agents`, `hosting_packages`, `hosting_package_versions`, `hosting_accounts`, `account_lifecycle_events`, `uid_allocations`, `jobs*`, `audit_logs`, `notifications`, `settings`, `impersonation_sessions` |
| 4 | `server_services`, `software_catalog`, `server_software`, `server_capacity`, `account_usage_snapshots`, `metric_samples` |
| 5 | `websites`, `domains`, `website_settings`, `certificates`, `acme_accounts`, `php_versions`, `dns_*` |
| 6 | `databases`, `database_users`, `database_grants`, `sftp_accounts`, `ssh_keys`, `cron_jobs`, `cron_runs`, `upload_sessions`, `terminal_sessions` |
| 7 | `firewall_rules`, `security_events`, `waf_*`, `malware_*`, `quarantine_items`, `fim_baselines` |
| 8 | `backup_*`, `restore_jobs`, `purge_records` |
| 9 | `agent_enrollment_tokens`, mở rộng `agents`, `account_migrations` |
| 10 | docker_*, `compose_*`, `port_allocations`, `wordpress_*` |
| 11 | `metric_rollups`, `alert_rules`, `alerts`, `uptime_checks`, `uptime_results`, `uptime_rollups`, `notification_channels`, `notification_preferences`, `notification_deliveries` |

**Lưu trữ số liệu (D-101, từ 11.3):** `metric_samples` 1 phút, partition theo ngày, giữ 7 ngày; `itso:metrics-prune` (hằng ngày) tạo trước partition 2 ngày tới, drop partition cũ (không DELETE) và xóa `metric_rollups` quá 90 ngày. `itso:metrics-rollup` (mỗi giờ) upsert min/avg/max/số mẫu theo giờ UTC, chạy bù khi trễ. API: khoảng ≤ 24 giờ đọc samples, dài hơn đọc rollup (trung bình theo số mẫu), tối đa ~500 điểm. Số liệu account (cpu_pct, ram, IO, tasks) lấy từ một lần `metrics.cgroup` theo lô mỗi server trong `itso:usage-refresh` (5 phút).
