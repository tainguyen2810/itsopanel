# 04 — Thiết kế database (mức kiến trúc)

> **Phạm vi chốt 2026-11-20 (nội bộ):** bản tổng hợp hiện hành nằm ở `seed/DATABASE.md`. File này vẫn là chi tiết kỹ thuật; phần nào mâu thuẫn thì theo `seed/DATABASE.md`.

PostgreSQL 16, cluster riêng `itso`, database `itso_panel`, role ứng dụng `itso_app` (không superuser, không CREATEROLE), role migration `itso_migrator` (chỉ dùng khi update).

## 1. Quy ước

- Khóa chính `id bigint generated always as identity`; cột `uuid` (UUIDv7) public dùng trong API/URL — không lộ id tuần tự.
- `created_at`, `updated_at timestamptz`; `deleted_at` cho soft-delete ở tài nguyên người dùng (websites, accounts, databases).
- Tên enum lưu dạng `text` + `CHECK` (dễ migrate hơn PG enum).
- Secret: cột `*_encrypted bytea` mã hóa ứng dụng (libsodium secretbox, khóa dẫn xuất từ master key `/var/lib/itso/keys/master.key` 0600). Không bao giờ log.
- JSONB có JSON Schema validate ở tầng ứng dụng; cột hay truy vấn được tách riêng.
- **Ownership:** mọi tài nguyên tenant có `hosting_account_id` → account có `owner_user_id` và `server_id`. Có `server_id` trên mọi bảng tài nguyên hệ thống ngay từ đầu (multi-server).
- **Desired/Observed:** bảng tài nguyên có nhóm cột chuẩn:
  `spec_version int`, `observed_version int`, `status text` (pending|provisioning|ready|degraded|failed|suspended|deleting), `observed_facts jsonb`, `drift jsonb`, `observed_at timestamptz`, `last_job_id bigint`.

## 2. Sơ đồ quan hệ chính

```
users ─< user_roles >─ roles ─< role_permissions >─ permissions
users ─< user_scopes (scope_type: server|hosting_account, scope_id)   ← phạm vi ADMIN
servers ─1:1─ agents
servers ─< hosting_accounts >─ hosting_packages
users(owner) ─< hosting_accounts
hosting_accounts ─< websites ─< domains
                 ─< databases ─< database_grants >─ database_users
                 ─< sftp_accounts, cron_jobs, ssh_keys, compose_projects
websites ─< certificates, website_settings(1:1), wordpress_sites(1:1), deployments
backup_policies ─< backup_jobs ─< backup_snapshots ;  backup_destinations ─< backup_policies
jobs ─< job_steps ─< job_logs ;  jobs ── (resource_type, resource_id)
audit_logs, security_events, notifications, settings, metric_samples
```

## 3. Danh sách bảng theo nhóm

### 3.1 Identity & Access
| Bảng | Cột chính | Ghi chú |
|---|---|---|
| `users` | uuid, name, email (citext unique), password_hash (argon2id), locale, timezone, status (active/locked/disabled), must_change_password, last_login_at, parent_user_id | `parent_user_id`: ADMIN tạo ra USER |
| `roles` | key (SUPER_ADMIN/ADMIN/USER), name | Seed cố định |
| `permissions` | key (`websites.create`, `servers.reboot`…), group | Seed từ code |
| `role_permissions` | role_id, permission_id | |
| `user_roles` | user_id, role_id | 1 role/user ở v0.1 |
| `user_scopes` | user_id, scope_type, scope_id | Phạm vi ADMIN |
| `mfa_credentials` | user_id, type (totp/webauthn/recovery), secret_encrypted, last_used_at | |
| `sessions` | id, user_id, ip, user_agent, last_activity, mfa_verified_at | Session DB driver |
| `api_tokens` | user_id, name, token_hash, scopes jsonb, expires_at, last_used_at | |
| `ip_allowlist` | cidr, scope (panel/api), note | |
| `login_attempts` | email, ip, success, at | Rate limit + Fail2ban panel |

### 3.2 Infrastructure
| Bảng | Cột chính |
|---|---|
| `servers` | uuid, name, hostname, ip_addresses jsonb, role_tags text[], os, kernel, status, desired/observed cols |
| `agents` | server_id unique, version, transport (local/mtls), cert_fingerprint, cert_expires_at, last_seen_at, capabilities jsonb |
| `agent_enrollment_tokens` | token_hash, expires_at, used_at, created_by |
| `server_services` | server_id, name, observed_state, enabled, observed_at |
| `software_catalog` | key, name, category, versions jsonb, conflicts text[] |
| `server_software` | server_id, key, version, status, desired/observed cols |
| `php_versions` | server_id, version, status, extensions jsonb |

### 3.3 Hosting
| Bảng | Cột chính | Ràng buộc/Index |
|---|---|---|
| `hosting_packages` | uuid, name, disk_mb, cpu_percent, ram_mb, tasks_max, io_weight, website_limit, database_limit, domain_limit, ftp_limit, cron_limit, cron_min_interval_min, backup_quota_mb, backup_retention jsonb, ssh_allowed, docker_allowed, php_versions text[], php_limits jsonb, is_active | unique(name) |
| `hosting_accounts` | uuid, server_id, package_id, owner_user_id, username (unique per server), uid, home_path, status, suspended_reason, limits_override jsonb, desired/observed cols | unique(server_id, username); unique(server_id, uid); idx(owner_user_id) |
| `account_usage_snapshots` | hosting_account_id, disk_mb, inode_count, cpu_seconds, mem_peak_mb, db_size_mb, backup_size_mb, at | idx(account, at desc) |
| `websites` | uuid, hosting_account_id, server_id, primary_domain, type (php/static/proxy/docker), document_root (relative), php_version, ssl_mode, status, desired/observed cols | unique(primary_domain) where deleted_at is null |
| `domains` | website_id, name (lowercase punycode), type (primary/alias/redirect), verified_at | **unique(name) toàn hệ thống** |
| `website_settings` | website_id PK, nginx jsonb, php jsonb, headers jsonb, custom_snippet text (chỉ SA/AD) | |
| `certificates` | website_id, issuer, domains text[], not_before, not_after, source (acme/upload), status, private_key_ref | idx(not_after) cho renew |
| `acme_accounts` | email, directory_url, key_encrypted | |
| `databases` | uuid, hosting_account_id, server_id, engine (mysql/mariadb/postgresql), name, size_mb, desired/observed cols | unique(server_id, engine, name) |
| `database_users` | hosting_account_id, engine, username, password_encrypted null, host_pattern, max_connections | |
| `database_grants` | database_id, database_user_id, privileges text[] | |
| `sftp_accounts` | hosting_account_id, username, root_subpath, auth (password/key), password_hash, status | |
| `ssh_keys` | hosting_account_id, name, public_key, fingerprint unique | |
| `cron_jobs` | hosting_account_id, schedule, command, timeout_sec, enabled, last_run_at, last_status | |
| `cron_runs` | cron_job_id, started_at, finished_at, exit_code, output_tail | partition/retention 30 ngày |
| `dns_providers` | type, name, credentials_encrypted, owner_scope | |
| `dns_zones`, `dns_records` | zone: provider_id, name, hosting_account_id; record: type, name, content, ttl, proxied | |

### 3.4 Docker
`docker_hosts(server_id, enabled, daemon_config jsonb)`, `registries(name, url, username, password_encrypted, owner_scope)`, `compose_projects(uuid, server_id, hosting_account_id null, name, status, current_revision_id, desired/observed cols)`, `compose_revisions(project_id, yaml text, validated_yaml text, validation_report jsonb, created_by)`, `containers(server_id, docker_id, name, image, project_id null, state, ports jsonb, observed_at)` (cache observed), `docker_volumes`, `docker_networks`, `docker_images` (observed cache).

### 3.5 Backup
| Bảng | Cột chính |
|---|---|
| `backup_destinations` | uuid, type (local/sftp/s3/rest), config jsonb, credentials_encrypted, **append_only bool**, immutable_days, restic_password_encrypted, owner_scope |
| `backup_policies` | uuid, name, scope_type (server/account/website/database/compose), scope_id, destination_id, schedule (cron), retention jsonb (keep-daily/weekly/monthly), include/exclude jsonb, enabled |
| `backup_jobs` | policy_id, job_id, started_at, finished_at, status, bytes_added, files_new |
| `backup_snapshots` | destination_id, restic_snapshot_id, scope_type, scope_id, tags text[], size_bytes, taken_at, verified_at | unique(destination_id, restic_snapshot_id) |
| `backup_verifications` | destination_id, type (check/restore-test), status, report jsonb |
| `restore_jobs` | snapshot_id, target_type, target_id, mode (new/overwrite), job_id, status |

### 3.6 Jobs
| Bảng | Cột chính | Ghi chú |
|---|---|---|
| `jobs` | uuid, type, server_id, resource_type, resource_id, requested_by, idempotency_key, state (queued/running/succeeded/failed/cancel_requested/cancelled/timed_out), progress 0–100, attempts, max_attempts, timeout_sec, error_code, error_message, parent_job_id, started_at, finished_at | unique(requested_by, idempotency_key); idx(state, created_at); idx(resource_type, resource_id) |
| `job_steps` | job_id, seq, op, op_id, params_redacted jsonb, state, attempts, result jsonb, compensation_op | |
| `job_logs` | job_id, step_id, level, message, at | retention 30 ngày |
| `resource_locks` (tùy chọn, có thể dùng Redis) | resource_key unique, job_id, expires_at | Chống 2 job cùng sửa một tài nguyên |

### 3.7 Security, Audit, Notifications, Settings, Monitoring
| Bảng | Cột chính |
|---|---|
| `audit_logs` | id, at, actor_user_id, impersonator_user_id, actor_ip, user_agent, action, resource_type, resource_id, server_id, job_id, changes jsonb (redacted), result, prev_hash, hash — **partition theo tháng, trigger chặn UPDATE/DELETE** |
| `security_events` | server_id, website_id null, type (ssh_bruteforce/waf_block/malware/fim_change/login_fail…), severity, source_ip inet, details jsonb, acknowledged_by, at |
| `firewall_rules` | server_id, priority, action, protocol, port_range, source_cidr, comment, managed_by (system/user) |
| `waf_settings`, `fim_baselines`, `malware_scans`, `malware_findings`, `quarantine_items` | |
| `notifications` | user_id, type, title, body, data jsonb, read_at |
| `notification_channels`, `notification_preferences` | |
| `settings` | group, key, value jsonb, is_encrypted, updated_by — unique(group,key) |
| `metric_samples` | server_id, hosting_account_id null, metric, value double, at — **partition theo ngày, giữ 7 ngày** |
| `metric_rollups` | như trên + bucket (1h), min/avg/max — giữ 90 ngày |
| `alert_rules`, `alerts`, `uptime_checks` | |
| `terminal_sessions` | user_id, uid, server_id, started_at, ended_at, recording_ref |

## 4. Index & ràng buộc quan trọng
- FK có `ON DELETE RESTRICT` cho tài nguyên hệ thống (không xóa account khi còn website); `CASCADE` chỉ cho bảng con thuần dữ liệu panel (job_logs, notifications).
- Partial unique cho soft-delete: `unique(primary_domain) where deleted_at is null`.
- Index cho truy vấn phân quyền: `hosting_accounts(owner_user_id)`, `user_scopes(user_id, scope_type)`, `websites(hosting_account_id)`.
- `pg_trgm` cho tìm kiếm domain/tên.
- **Defense-in-depth (P1):** Row-Level Security trên bảng tenant với `current_setting('itso.user_id')` — xem xét ở Phase 12; v0.1 dựa vào Laravel Policies + global scopes + test ma trận quyền.

## 5. Migrations
- Laravel migrations, chia theo module, đánh số theo phase (`2026_..._p03_create_users_table`).
- **Expand → migrate → contract:** migration của bản N phải chạy được khi code N-1 vẫn đang chạy (cho rollback). Không xóa/đổi tên cột trong cùng release thêm cột mới.
- Trước mỗi update: `pg_dump` cluster `itso` vào `/var/backups/itso/pre-update/<version>.dump` (tự động bởi `itso update`).
- Seeder tách: `ProductionSeeder` (roles, permissions, catalog) vs `DemoSeeder` (dữ liệu demo từ `demo/*.json`, **chỉ chạy khi `APP_ENV=demo`**; installer production không bao giờ chạy).
- CI: `migrate:fresh` + `migrate:rollback` + kiểm tra schema dump khớp.
