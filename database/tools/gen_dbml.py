#!/usr/bin/env python3
"""Sinh database/schema/itso.dbml (nguồn đặc tả schema ITSO Panel, phạm vi nội bộ).

Viết bằng Python để tái dùng nhóm cột chuẩn (timestamps, desired/observed).
File DBML sinh ra được commit và là tài liệu chính; sửa schema thì sửa file này rồi chạy
`make db-schema` (sinh DBML → SQL). Ràng buộc mà DBML không biểu diễn được (CHECK, partial
unique, trigger, partition) nằm ở database/schema/extras.sql.
"""
import re
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "schema" / "itso.dbml"

TS = ["created_at timestamptz [not null, default: `now()`]",
      "updated_at timestamptz [not null, default: `now()`]"]
SOFT = ["deleted_at timestamptz"]
# Nhóm cột Desired / Observed (ARCHITECTURE.md §4)
DO = [
    "spec_version int [not null, default: 1, note: 'Desired: tăng mỗi lần đổi cấu hình']",
    "observed_version int [not null, default: 0, note: 'Observed: phiên bản agent đã áp dụng']",
    "status text [not null, default: 'pending', note: 'pending|provisioning|ready|degraded|failed|suspended|deleting']",
    "observed_facts jsonb [not null, default: `'{}'::jsonb`]",
    "drift jsonb",
    "observed_at timestamptz",
    "last_job_id bigint [ref: > jobs.id]",
]
ID = ["id bigint [pk, increment]", "uuid uuid [not null, unique, default: `gen_random_uuid()`]"]
IDN = ["id bigint [pk, increment]"]

tables = []  # (group, name, cols, indexes, note)


def t(group, name, cols, indexes=(), note=""):
    tables.append((group, name, cols, list(indexes), note))


# ---------------------------------------------------------------- Identity
t("identity", "users", ID + [
    "realm text [not null, note: 'admin | portal — bất biến (trigger)']",
    "name text [not null]",
    "email citext [not null, unique]",
    "password_hash text [not null, note: 'argon2id']",
    "locale text [not null, default: 'vi']",
    "timezone text [not null, default: 'Asia/Ho_Chi_Minh']",
    "status text [not null, default: 'active', note: 'active|locked|disabled']",
    "must_change_password boolean [not null, default: false]",
    "created_by_user_id bigint [ref: > users.id]",
    "last_login_at timestamptz",
] + TS, ["realm", "status"], "Người dùng. realm=admin: SUPER_ADMIN/ADMIN; realm=portal: USER (D-25, D-40).")
t("identity", "roles", IDN + ["key text [not null, unique, note: 'SUPER_ADMIN|ADMIN|USER']",
                              "realm text [not null]", "name text [not null]"] + TS)
t("identity", "permissions", IDN + ["key text [not null, unique, note: 'vd websites.create']",
                                    "group_key text [not null]", "description text"] + TS)
t("identity", "role_permissions", [
    "role_id bigint [not null, ref: > roles.id]",
    "permission_id bigint [not null, ref: > permissions.id]",
], ["(role_id, permission_id) [pk]"])
t("identity", "user_roles", [
    "user_id bigint [not null, unique, ref: > users.id, note: 'v0.x: 1 vai trò/user']",
    "role_id bigint [not null, ref: > roles.id]",
] + TS, ["role_id"])
t("identity", "user_scopes", IDN + [
    "user_id bigint [not null, ref: > users.id]",
    "scope_type text [not null, note: 'server|hosting_account']",
    "scope_id bigint [not null]",
] + TS, ["(user_id, scope_type, scope_id) [unique]", "(scope_type, scope_id)"],
  "Phạm vi được giao cho ADMIN.")
t("identity", "mfa_credentials", IDN + [
    "user_id bigint [not null, ref: > users.id]",
    "type text [not null, note: 'totp|webauthn|recovery']",
    "secret_encrypted bytea [not null]",
    "label text", "last_used_at timestamptz",
] + TS, ["user_id"])
t("identity", "sessions", [
    "id text [pk]", "user_id bigint [ref: > users.id]", "realm text [not null]",
    "ip_address inet", "user_agent text", "payload text [not null]",
    "mfa_verified_at timestamptz", "last_activity bigint [not null]",
], ["user_id", "last_activity"])
t("identity", "api_tokens", IDN + [
    "user_id bigint [not null, ref: > users.id]", "name text [not null]",
    "token_hash text [not null, unique]", "scopes jsonb [not null, default: `'[]'::jsonb`]",
    "allowed_cidrs cidr[]", "expires_at timestamptz", "last_used_at timestamptz",
] + TS, ["user_id"], "Token nội bộ (automation, CLI). Không có Public Provisioning API (DEFERRED).")
t("identity", "login_attempts", IDN + [
    "realm text [not null]", "email citext [not null]", "ip_address inet [not null]",
    "success boolean [not null]", "at timestamptz [not null, default: `now()`]",
], ["(email, at)", "(ip_address, at)"])
t("identity", "ip_allowlist", IDN + [
    "cidr cidr [not null]", "scope text [not null, default: 'admin']", "note text",
    "created_by_user_id bigint [ref: > users.id]",
] + TS, ["(scope, cidr) [unique]"])
t("identity", "impersonation_sessions", IDN + [
    "staff_user_id bigint [not null, ref: > users.id]",
    "target_user_id bigint [not null, ref: > users.id]",
    "reason text [not null]", "started_at timestamptz [not null, default: `now()`]",
    "ended_at timestamptz", "expires_at timestamptz [not null]",
], ["staff_user_id", "target_user_id"])
t("identity", "tos_acceptances", IDN + [
    "user_id bigint [not null, ref: > users.id]", "version text [not null]",
    "accepted_at timestamptz [not null, default: `now()`]", "ip_address inet",
], ["(user_id, version) [unique]"])

# ---------------------------------------------------------------- Infrastructure
t("infra", "servers", ID + [
    "name text [not null, unique]", "hostname text [not null]",
    "ip_addresses jsonb [not null, default: `'[]'::jsonb`]",
    "role_tags text[] [not null, default: `'{}'`, note: 'web|db|backup|docker|control-plane']",
    "os text", "kernel text", "accepting_new_accounts boolean [not null, default: true]",
] + DO + TS + SOFT)
t("infra", "agents", IDN + [
    "server_id bigint [not null, unique, ref: > servers.id]", "version text",
    "transport text [not null, default: 'local', note: 'local|mtls']",
    "cert_fingerprint text", "cert_expires_at timestamptz",
    "capabilities jsonb [not null, default: `'{}'::jsonb`]", "last_seen_at timestamptz",
] + TS)
t("infra", "agent_enrollment_tokens", IDN + [
    "uuid uuid [not null, unique, default: `gen_random_uuid()`]",
    "token_hash text [not null, unique, note: 'sha256 của token 32 byte; token chỉ hiện một lần (D-90)']",
    "server_name text [not null, note: 'Tên server sẽ tạo khi node join']",
    "role_tags text[] [not null, default: `'{}'`]",
    "created_by_user_id bigint [not null, ref: > users.id]",
    "expires_at timestamptz [not null, note: 'Mặc định 1 giờ']", "used_at timestamptz",
    "used_by_server_id bigint [ref: > servers.id]",
    "used_from_ip inet",
] + TS, [], "Token join node dùng một lần (D-90).")
t("infra", "agent_certificates", IDN + [
    "server_id bigint [not null, ref: > servers.id]",
    "serial text [not null, unique, note: 'Số serial hex do CA nội bộ cấp']",
    "fingerprint_sha256 text [not null, unique]",
    "not_before timestamptz [not null]", "not_after timestamptz [not null]",
    "issued_reason text [not null, note: 'enroll|rotate|rejoin']",
    "revoked_at timestamptz", "revoked_reason text [note: 'revoke|superseded|rejoin']",
    "created_at timestamptz [not null, default: `now()`]",
], ["server_id", "revoked_at"],
  "Lịch sử chứng chỉ mTLS của node + danh sách thu hồi cho itso-relay (D-89, D-90).")
t("infra", "server_services", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "name text [not null]",
    "observed_state text", "enabled boolean", "observed_at timestamptz",
], ["(server_id, name) [unique]"])
t("infra", "server_capacity", [
    "server_id bigint [pk, ref: - servers.id]",
    "cpu_cores int [not null, default: 0]", "ram_mb int [not null, default: 0]",
    "disk_mb bigint [not null, default: 0]",
    "allocated_cpu_pct int [not null, default: 0]", "allocated_ram_mb int [not null, default: 0]",
    "allocated_disk_mb bigint [not null, default: 0]", "account_count int [not null, default: 0]",
    "max_accounts int [not null, default: 200]",
    "updated_at timestamptz [not null, default: `now()`]",
], note="Dùng để gợi ý server khi tạo account (D-42) và khóa SELECT FOR UPDATE khi cấp.")
t("infra", "software_catalog", IDN + [
    "key text [not null, unique]", "name text [not null]", "category text [not null]",
    "versions jsonb [not null, default: `'[]'::jsonb`]", "conflicts text[] [not null, default: `'{}'`]",
] + TS)
t("infra", "server_software", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "software_key text [not null]",
    "version text",
] + DO + TS, ["(server_id, software_key) [unique]"])
t("infra", "php_versions", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "version text [not null]",
    "extensions jsonb [not null, default: `'[]'::jsonb`]",
] + DO + TS, ["(server_id, version) [unique]"])
t("infra", "uid_allocations", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "uid int [not null]",
    "hosting_account_id bigint [ref: > hosting_accounts.id]",
    "allocated_at timestamptz [not null, default: `now()`]", "released_at timestamptz",
], ["(server_id, uid) [unique]"], "Dải 20000–59999, không tái dùng trong 90 ngày (D-45).")

# ---------------------------------------------------------------- Hosting
LIMITS = [
    "disk_mb int [not null]", "inode_limit int [not null]", "cpu_percent int [not null]",
    "ram_mb int [not null]", "tasks_max int [not null]", "php_workers_max int [not null]",
    "io_weight int [not null, default: 100]", "io_read_bps bigint", "io_write_bps bigint",
    "website_limit int [not null]", "alias_domain_limit int [not null]",
    "subdomain_limit int [not null]", "database_limit int [not null]",
    "db_user_limit int [not null]", "ftp_limit int [not null]", "cron_limit int [not null]",
    "cron_min_interval_min int [not null, default: 5]",
    "backup_quota_mb int [not null]", "backup_retention jsonb [not null, default: `'{}'::jsonb`]",
    "ssh_allowed boolean [not null, default: false]",
    "php_versions text[] [not null, default: `'{}'`]",
    "php_limits jsonb [not null, default: `'{}'::jsonb`]",
    "retention_days_after_terminate int [not null, default: 30]",
]
t("hosting", "hosting_packages", ID + [
    "code text [not null, unique]", "name text [not null]", "description text",
    "current_version int [not null, default: 1]", "is_active boolean [not null, default: true]",
] + TS + SOFT, note="Gói hosting; giá trị giới hạn nằm ở hosting_package_versions (bất biến, D-43).")
t("hosting", "hosting_package_versions", IDN + [
    "package_id bigint [not null, ref: > hosting_packages.id]", "version int [not null]",
] + LIMITS + ["created_by_user_id bigint [ref: > users.id]",
              "created_at timestamptz [not null, default: `now()`]"],
  ["(package_id, version) [unique]"])
t("hosting", "hosting_accounts", ID + [
    "server_id bigint [not null, ref: > servers.id]",
    "package_version_id bigint [not null, ref: > hosting_package_versions.id]",
    "owner_user_id bigint [not null, ref: > users.id]",
    "username text [not null]", "uid int [not null]", "home_path text [not null]",
    "lifecycle_state text [not null, default: 'pending', note: 'pending|provisioning|active|suspended|migrating|terminated|purged|failed']",
    "suspended_reason text", "limits_override jsonb [not null, default: `'{}'::jsonb`]",
    "terminated_at timestamptz", "purge_after timestamptz",
    "legal_hold boolean [not null, default: false]",
    "migrated_from_account_id bigint [ref: > hosting_accounts.id]",
] + DO + TS + SOFT,
  ["(server_id, username) [unique]", "(server_id, uid) [unique]", "owner_user_id",
   "lifecycle_state", "purge_after"],
  "Đơn vị cách ly = 1 Linux user trên 1 server (D-44).")
t("hosting", "account_lifecycle_events", IDN + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "from_state text", "to_state text [not null]", "reason text",
    "actor_user_id bigint [ref: > users.id]", "job_id bigint [ref: > jobs.id]",
    "at timestamptz [not null, default: `now()`]",
], ["(hosting_account_id, at)"])
t("hosting", "account_usage_snapshots", IDN + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "disk_mb bigint", "inode_count bigint", "cpu_seconds float8",
    "mem_peak_mb int", "db_size_mb bigint", "backup_size_mb bigint",
    "at timestamptz [not null, default: `now()`]",
], ["(hosting_account_id, at)"])
t("hosting", "account_migrations", ID + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "source_server_id bigint [not null, ref: > servers.id]",
    "target_server_id bigint [not null, ref: > servers.id]",
    "target_account_id bigint [ref: > hosting_accounts.id]",
    "state text [not null, default: 'preflight', note: 'preflight|syncing|verifying|cutover|holding|completed|rolled_back|failed']",
    "keep_source_days int [not null, default: 7]",
    "verification jsonb [not null, default: `'[]'::jsonb`, note: 'Danh sách {kind, name, ok, detail}: file sha256, DB, HTTP, SSL, cron, UID']",
    "preflight jsonb [note: 'Kết quả kiểm tra trước lúc bắt đầu']",
    "dns jsonb [note: '{mode auto|manual, zone, records[]}']",
    "sync_snapshot_id text [note: 'Snapshot restic dùng để đồng bộ lượt đầu']",
    "final_snapshot_id text [note: 'Snapshot lượt cuối lúc cutover']",
    "bytes_synced bigint [not null, default: 0]", "downtime_estimate_sec int", "downtime_sec int",
    "job_id bigint [ref: > jobs.id]", "cutover_at timestamptz", "cleanup_after timestamptz",
    "cleaned_at timestamptz", "error text",
    "requested_by_user_id bigint [not null, ref: > users.id]",
] + TS, ["hosting_account_id", "state"],
  "Chuyển account giữa server qua repo restic (D-93): preflight → syncing → verifying → cutover → holding → completed; rollback tới trước dọn dẹp.")
t("hosting", "purge_records", ID + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "requested_by_user_id bigint [not null, ref: > users.id]",
    "confirmed_by_user_id bigint [ref: > users.id]",
    "final_backup_snapshot_id bigint [ref: > backup_snapshots.id]",
    "backup_verified_at timestamptz",
    "objects jsonb [not null, default: `'[]'::jsonb`, note: 'đường dẫn, DB, repo, hash']",
    "scheduled_for timestamptz [not null]", "completed_at timestamptz",
] + TS, ["hosting_account_id"], "Biên bản purge (D-46).")
t("hosting", "websites", ID + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "server_id bigint [not null, ref: > servers.id]",
    "primary_domain text [not null]", "type text [not null, default: 'php', note: 'php|static|proxy|docker']",
    "document_root text [not null, default: 'public']", "php_version text",
    "ssl_mode text [not null, default: 'none', note: 'none|acme|custom']",
] + DO + TS + SOFT, ["hosting_account_id", "server_id"])
t("hosting", "domains", ID + [
    "website_id bigint [not null, ref: > websites.id]",
    "name text [not null, note: 'lowercase punycode']",
    "type text [not null, default: 'alias', note: 'primary|alias|redirect|subdomain']",
    "verified_at timestamptz",
] + TS + SOFT, ["website_id"])
t("hosting", "website_settings", [
    "website_id bigint [pk, ref: - websites.id]",
    "nginx jsonb [not null, default: `'{}'::jsonb`]", "php jsonb [not null, default: `'{}'::jsonb`]",
    "headers jsonb [not null, default: `'{}'::jsonb`]", "waf jsonb [not null, default: `'{}'::jsonb`]",
    "custom_snippet text [note: 'chỉ SUPER_ADMIN/ADMIN']",
    "updated_at timestamptz [not null, default: `now()`]",
])
t("hosting", "acme_accounts", IDN + [
    "server_id bigint [not null, ref: > servers.id]",
    "email citext [not null]", "directory_url text [not null]",
    "key_location text [not null, default: 'agent', note: 'agent: khóa ACME giữ trên máy do agent quản lý (D-69)']",
    "key_encrypted bytea [note: 'chỉ dùng khi key_location = db']",
] + TS, ["(server_id, email, directory_url) [unique]"])
t("hosting", "certificates", ID + [
    "website_id bigint [ref: > websites.id]", "server_id bigint [not null, ref: > servers.id]",
    "issuer text", "domains text[] [not null]", "source text [not null, note: 'acme|upload']",
    "not_before timestamptz", "not_after timestamptz", "private_key_ref text",
    "private_key_encrypted bytea [note: 'chứng chỉ tải lên: khóa riêng mã hóa (D-69), không đưa vào job']",
    "acme_account_id bigint [ref: > acme_accounts.id]", "auto_renew boolean [not null, default: true]",
    "last_renew_attempt_at timestamptz", "last_error text",
] + DO + TS, ["website_id", "not_after"])
t("hosting", "databases", ID + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "server_id bigint [not null, ref: > servers.id]",
    "engine text [not null, note: 'mariadb|mysql|postgresql']", "name text [not null]",
    "charset text [not null, default: 'utf8mb4']", "size_mb bigint",
] + DO + TS + SOFT, ["hosting_account_id"])
t("hosting", "database_users", ID + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "server_id bigint [not null, ref: > servers.id]", "engine text [not null]",
    "username text [not null]",
    "password_encrypted bytea [note: 'mã hóa; job chỉ mang tham chiếu bí mật (D-71)']",
    "host_pattern text [not null, default: 'localhost']",
    "max_connections int [not null, default: 10]",
] + DO + TS + SOFT, ["hosting_account_id"])
t("hosting", "database_grants", [
    "database_id bigint [not null, ref: > databases.id]",
    "database_user_id bigint [not null, ref: > database_users.id]",
    "privileges text[] [not null]",
], ["(database_id, database_user_id) [pk]"])
t("hosting", "sftp_accounts", ID + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "username text [not null]", "root_subpath text [not null, default: '']",
    "protocol text [not null, default: 'sftp', note: 'sftp: user Linux của account; ftps: virtual user Pure-FTPd (D-73)']",
    "password_encrypted bytea [note: 'mã hóa; job chỉ mang tham chiếu bí mật']",
    "read_only boolean [not null, default: false]", "last_login_at timestamptz",
] + DO + TS + SOFT, ["hosting_account_id"])
t("hosting", "ssh_keys", ID + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]", "name text [not null]",
    "type text [not null, note: 'ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa']",
    "public_key text [not null]", "fingerprint text [not null, note: 'SHA256:… (base64 không padding)']",
    "last_used_at timestamptz",
] + TS, ["(hosting_account_id, fingerprint) [unique]"])
t("hosting", "cron_jobs", ID + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "website_id bigint [ref: > websites.id]",
    "schedule text [not null]", "command text [not null]", "working_dir text [not null, default: '.']",
    "php_version text", "timeout_sec int [not null, default: 3600]",
    "enabled boolean [not null, default: true]", "last_run_at timestamptz", "last_status text",
] + DO + TS + SOFT, ["hosting_account_id"])
t("hosting", "cron_runs", ID + [
    "cron_job_id bigint [not null, ref: > cron_jobs.id]", "started_at timestamptz [not null]",
    "finished_at timestamptz", "exit_code int", "output_tail text",
    "status text [not null, default: 'running', note: 'running|succeeded|failed|timed_out']",
    "trigger text [not null, default: 'schedule', note: 'schedule|manual']",
], ["(cron_job_id, started_at)"])
t("hosting", "dns_providers", ID + [
    "type text [not null, note: 'cloudflare']", "name text [not null]",
    "credentials_encrypted bytea [not null]", "account_label text",
    "created_by_user_id bigint [ref: > users.id]",
] + TS)
t("hosting", "dns_zones", ID + [
    "provider_id bigint [not null, ref: > dns_providers.id]", "name text [not null]",
    "external_id text", "hosting_account_id bigint [ref: > hosting_accounts.id]",
] + TS, ["(provider_id, name) [unique]"])
t("hosting", "dns_records", ID + [
    "zone_id bigint [not null, ref: > dns_zones.id]", "type text [not null]", "name text [not null]",
    "content text [not null]", "ttl int [not null, default: 300]", "priority int",
    "proxied boolean [not null, default: false]", "external_id text",
] + TS, ["zone_id"])
t("hosting", "upload_sessions", ID + [
    "user_id bigint [not null, ref: > users.id]",
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "target_path text [not null]", "size_bytes bigint [not null]", "received_bytes bigint [not null, default: 0]",
    "overwrite boolean [not null, default: false]",
    "status text [not null, default: 'receiving', note: 'receiving|committing|completed|failed|cancelled']",
    "job_id bigint [ref: > jobs.id]",
    "expires_at timestamptz [not null]",
] + TS, ["hosting_account_id", "expires_at"])
t("hosting", "file_operations", ID + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "user_id bigint [ref: > users.id]",
    "op text [not null, note: 'write|mkdir|rename|move|copy|delete|chmod|compress|extract|upload']",
    "paths jsonb [not null, default: `'[]'::jsonb`]", "target text",
    "status text [not null, default: 'succeeded', note: 'queued|running|succeeded|failed']",
    "job_id bigint [ref: > jobs.id]", "error_code text",
    "created_at timestamptz [not null, default: `now()`]",
], ["(hosting_account_id, created_at)"])
t("hosting", "terminal_sessions", ID + [
    "user_id bigint [not null, ref: > users.id]", "server_id bigint [not null, ref: > servers.id]",
    "hosting_account_id bigint [ref: > hosting_accounts.id]", "unix_uid int [not null]",
    "mode text [not null, default: 'account', note: 'account|root (root: Phase 7)']",
    "started_at timestamptz [not null, default: `now()`]", "ended_at timestamptz",
    "ended_reason text [note: 'closed|idle|expired|error']", "recording_ref text",
], ["user_id", "hosting_account_id"])
t("hosting", "wordpress_sites", ID + [
    "website_id bigint [not null, unique, ref: - websites.id]",
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "path text [not null, note: 'Docroot tương đối home account (RelPath); agent kiểm lại sau khi resolve symlink']",
    "version text", "admin_user text", "multisite boolean [not null, default: false]",
    "state text [not null, default: 'ok', note: 'ok|updating|cloning|maintenance|error (D-99)']",
    "auto_update text [not null, default: 'minor', note: 'off|minor|all']",
    "update_window text [not null, default: '02:00-05:00', note: 'HH:00-HH:00 theo giờ server']",
    "maintenance boolean [not null, default: false]",
    "hardening jsonb [not null, default: `'{}'::jsonb`, note: 'file_edit_disabled, xmlrpc_blocked, php_in_uploads_blocked, wp_config_protected, version_hidden, salts_rotated']",
    "staging_of_id bigint [ref: > wordpress_sites.id, note: 'Bản staging trỏ về site gốc; đẩy staging → production DEFERRED']",
    "checksums_ok boolean", "last_scan_at timestamptz", "last_update_at timestamptz",
    "database_id bigint [ref: > databases.id, note: 'DB của site (DB_NAME trong wp-config); snapshot pre-wp-update gồm DB này']",
    "last_auto_update_at timestamptz [note: 'Lần tự cập nhật gần nhất (scheduler chạy tối đa một lần mỗi cửa sổ)']",
] + TS + SOFT, ["hosting_account_id", "staging_of_id"], "Site WordPress do Toolkit quản lý (D-99, ADR 0044).")
t("hosting", "wordpress_components", IDN + [
    "wordpress_site_id bigint [not null, ref: > wordpress_sites.id]",
    "type text [not null, note: 'core|plugin|theme']", "slug text [note: 'null với core; ^[a-z0-9][a-z0-9_-]{0,99}$']",
    "name text [not null]", "version text [not null]", "update_version text", "active boolean [not null, default: true]",
    "observed_at timestamptz [not null, default: `now()`]",
], ["(wordpress_site_id, type, slug) [unique]"], "Cache wp.info: core, plugin, theme và bản mới.")
t("hosting", "wordpress_updates", ID + [
    "wordpress_site_id bigint [not null, ref: > wordpress_sites.id]",
    "job_id bigint [ref: > jobs.id]", "trigger text [not null, default: 'manual', note: 'manual|auto']",
    "items jsonb [not null, default: `'[]'::jsonb`, note: '[{type, slug, from_version, to_version, ok}]']",
    "steps jsonb [not null, default: `'[]'::jsonb`, note: 'snapshot|maintenance|update|verify|rollback → done|failed|skipped']",
    "state text [not null, default: 'running', note: 'running|succeeded|rolled_back|failed']",
    "snapshot_id bigint [ref: > backup_snapshots.id, note: 'Snapshot pre-wp-update dùng để khôi phục']",
    "error text", "requested_by_user_id bigint [ref: > users.id]",
    "started_at timestamptz", "finished_at timestamptz",
] + TS, ["(wordpress_site_id, created_at)"], "Lịch sử cập nhật an toàn (D-99).")
t("hosting", "git_repositories", ID + [
    "website_id bigint [not null, unique, ref: - websites.id]",
    "repo_url text [not null, note: 'ssh://git@host/owner/repo.git hoặc https://']",
    "branch text [not null, default: 'main']",
    "deploy_key_public text [not null, note: 'ed25519, sinh cho từng site; khóa riêng ở vault của agent']",
    "deploy_key_fingerprint text [not null]",
    "webhook_secret_encrypted bytea [not null, note: 'HMAC-SHA256 cho POST /hooks/git/{token}']",
    "webhook_token text [not null, unique]",
    "auto_deploy boolean [not null, default: false]",
    "build_command text [note: 'chạy dưới UID account trong slice; một dòng']",
    "shared_paths jsonb [not null, default: `'[]'::jsonb`, note: 'đường dẫn giữ qua các release, vd .env, storage']",
    "keep_releases int [not null, default: 5]",
    "current_deployment_id bigint",
] + DO + TS + SOFT, [], "Git deploy theo site (module 22): releases + symlink, rollback.")
t("hosting", "git_deployments", ID + [
    "git_repository_id bigint [not null, ref: > git_repositories.id]",
    "commit_sha text [not null]", "commit_message text", "commit_author text",
    "trigger text [not null, note: 'manual|webhook|rollback']",
    "state text [not null, default: 'queued', note: 'queued|running|succeeded|failed|rolled_back']",
    "release_path text [note: 'releases/<timestamp> tương đối home']",
    "rollback_of_id bigint [ref: > git_deployments.id]",
    "job_id bigint [ref: > jobs.id]",
    "requested_by_user_id bigint [ref: > users.id]",
    "started_at timestamptz", "finished_at timestamptz",
] + TS, ["(git_repository_id, created_at)"])

# ---------------------------------------------------------------- Docker (chỉ admin)
t("docker", "docker_hosts", [
    "server_id bigint [pk, ref: - servers.id]", "enabled boolean [not null, default: false]",
    "state text [not null, default: 'not_installed', note: 'not_installed|installing|enabled|degraded']",
    "engine_version text", "compose_version text", "api_version text",
    "daemon_config jsonb [not null, default: `'{}'::jsonb`, note: 'daemon.json do panel quản lý (D-94)']",
    "checks jsonb [not null, default: `'[]'::jsonb`]",
    "port_range_from int [not null, default: 20000]", "port_range_to int [not null, default: 29999]",
    "firewall_synced_at timestamptz", "observed_at timestamptz",
] + TS, [], "Docker trên server (D-94, D-95). Nhóm docker phải rỗng; chỉ agent chạm socket.")
t("docker", "registries", ID + [
    "name text [not null, unique]", "url text [not null]", "username text",
    "password_encrypted bytea [note: 'Crypt; tới agent qua secret_ref, không vào params job/audit (D-98)']",
    "last_test_at timestamptz", "last_test_ok boolean", "last_test_message text",
    "created_by_user_id bigint [ref: > users.id]",
] + TS + SOFT)
t("docker", "compose_projects", ID + [
    "server_id bigint [not null, ref: > servers.id]", "name text [not null]",
    "run_state text [not null, default: 'stopped', note: 'running|stopped|partial|error|deploying (API: status)']",
    "template text", "env_encrypted bytea [note: 'Biến môi trường (JSON, Crypt); ghi .env 0600 trên node']",
    "current_revision_id bigint [ref: > compose_revisions.id]",
    "created_by_user_id bigint [ref: > users.id]",
] + DO + TS + SOFT, ["(server_id, name) [unique]"], "Compose project chỉ admin (D-96); Docker cho USER DEFERRED.")
t("docker", "compose_revisions", IDN + [
    "project_id bigint [not null, ref: > compose_projects.id]", "number int [not null]", "yaml text [not null]",
    "validated_yaml text", "validated_sha256 text",
    "ok boolean [not null, default: false]", "findings_count int [not null, default: 0]",
    "validation_report jsonb [note: 'findings + rewrites của compose.validate']",
    "overrides jsonb [not null, default: `'[]'::jsonb`, note: '[{rule, reason, by_user_uuid, at}] chỉ SUPER_ADMIN']",
    "created_by_user_id bigint [ref: > users.id]",
    "created_at timestamptz [not null, default: `now()`]",
], ["(project_id, number) [unique]"], "Revision bất biến (ADR 0041).")
t("docker", "containers", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "docker_id text [not null]", "name text [not null]",
    "image text [not null]", "image_digest text", "project_id bigint [ref: > compose_projects.id]", "service text",
    "state text", "health text",
    "ports jsonb [not null, default: `'[]'::jsonb`]", "observed_at timestamptz [not null]",
], ["(server_id, docker_id) [unique]", "project_id"], "Cache observed từ agent.")
t("docker", "port_allocations", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "port int [not null]",
    "protocol text [not null, default: 'tcp', note: 'tcp|udp']",
    "compose_project_id bigint [not null, ref: > compose_projects.id]", "service text [not null]",
    "container_port int [not null]",
    "created_at timestamptz [not null, default: `now()`]",
], ["(server_id, port, protocol) [unique]", "compose_project_id"], "Dải 20000–29999 mỗi server, cấp trong transaction (D-97).")
t("docker", "image_rollbacks", IDN + [
    "compose_project_id bigint [not null, ref: > compose_projects.id]", "service text [not null]",
    "from_digest text [not null]", "to_digest text [not null]",
    "rollback_tag text [not null, note: 'itso-rollback/<project>-<service>:<yyyymmddhhmmss>']",
    "state text [not null, default: 'running', note: 'running|succeeded|rolled_back|failed']",
    "reason text", "job_id bigint [ref: > jobs.id]", "requested_by_user_id bigint [ref: > users.id]",
    "released_at timestamptz [note: 'Hết giữ (quá 2 bản/service) → prune được xóa']",
    "created_at timestamptz [not null, default: `now()`]",
], ["(compose_project_id, service, created_at)"], "Cập nhật image có rollback (D-98, ADR 0043).")

# ---------------------------------------------------------------- Backup (D-82…D-87, ADR 0029–0033)
t("backup", "backup_destinations", ID + [
    "name text [not null]", "type text [not null, note: 'local|sftp|s3|rest']",
    "server_id bigint [ref: > servers.id, note: 'local: máy chủ giữ repo; đích từ xa: null']",
    "config jsonb [not null, default: `'{}'::jsonb`, note: 'Không bí mật: host, port, user, path, endpoint, bucket, url']",
    "credentials_encrypted bytea [note: 'Credential GHI (S3 key, mật khẩu rest); không bao giờ là credential prune (D-83)']",
    "append_only boolean [not null, default: false, note: 'Khai báo của SA']", "immutable_days int",
    "detected jsonb [note: 'Phát hiện ở lần kiểm tra: {append_only, object_lock_days}']",
    "ssh_public_key text [note: 'SFTP: khóa công khai; khóa riêng chỉ ở agent /etc/itso/backup/keys']",
    "host_key_sha256 text [note: 'SFTP: host key ghim ở lần kiểm tra đầu']",
    "enabled boolean [not null, default: true]",
    "last_check_at timestamptz", "last_check_ok boolean", "last_check_error text",
    "recovery_kit_acknowledged_at timestamptz",
    "recovery_kit_acknowledged_by_user_id bigint [ref: > users.id]",
] + TS + SOFT, ["type"], "Đích backup (D-83). Mật khẩu restic nằm ở backup_repositories, không ở đích.")
t("backup", "backup_repositories", ID + [
    "destination_id bigint [not null, ref: > backup_destinations.id]",
    "server_id bigint [not null, ref: > servers.id]",
    "scope_type text [not null, note: 'hosting_account|server']",
    "hosting_account_id bigint [ref: > hosting_accounts.id, note: 'repo riêng theo account (D-23)']",
    "path text [not null, note: 'Do agent dựng: itso/<server_uuid>/acct-<account_uuid> | itso/<server_uuid>/server']",
    "password_encrypted bytea [not null, note: '32 byte ngẫu nhiên, Crypt; chỉ đi qua tham chiếu bí mật backup_repo_password (D-69)']",
    "initialized_at timestamptz", "size_bytes bigint [not null, default: 0, note: 'restic stats --mode raw-data']",
    "snapshots_count int [not null, default: 0]", "last_snapshot_at timestamptz",
    "last_check_at timestamptz", "last_check_ok boolean",
    "quota_state text [not null, default: 'ok', note: 'ok|warn|paused (D-86)']",
] + TS + SOFT, ["(destination_id, path) [unique]", "hosting_account_id", "server_id"],
  "Repo restic = đích × account hoặc đích × server (D-82).")
t("backup", "backup_policies", ID + [
    "name text [not null]",
    "scope_type text [not null, note: 'all_accounts|hosting_account|website|database|server|panel']",
    "scope_id bigint [note: 'id theo scope_type; null cho all_accounts/panel']",
    "contents text[] [not null, default: `'{files,databases}'`, note: 'files|databases|config']",
    "excludes text[] [not null, default: `'{}'`, note: 'Mẫu loại trừ tương đối (≤ 50), cộng thêm loại trừ cố định của agent']",
    "schedule text [not null]", "retention jsonb [not null, default: `'{}'::jsonb`, note: 'Mong muốn: last, hourly, daily, weekly, monthly; chỉ áp khi đích cho phép prune từ panel']",
    "enabled boolean [not null, default: true]",
    "last_run_at timestamptz", "next_run_at timestamptz", "last_status text [note: 'succeeded|failed|running']",
] + TS + SOFT, ["(scope_type, scope_id)", "next_run_at"])
t("backup", "backup_policy_destinations", [
    "policy_id bigint [not null, ref: > backup_policies.id]",
    "destination_id bigint [not null, ref: > backup_destinations.id]",
], ["(policy_id, destination_id) [pk]", "destination_id"], "Một policy ghi vào nhiều đích (3-2-1).")
t("backup", "backup_jobs", IDN + [
    "policy_id bigint [ref: > backup_policies.id]", "job_id bigint [ref: > jobs.id]",
    "repository_id bigint [ref: > backup_repositories.id]",
    "snapshot_id bigint [ref: > backup_snapshots.id]",
    "started_at timestamptz", "finished_at timestamptz", "status text [not null]",
    "bytes_added bigint", "files_new int",
], ["policy_id", "repository_id"])
t("backup", "backup_snapshots", IDN + [
    "uuid uuid [not null, unique, default: `gen_random_uuid()`]",
    "destination_id bigint [not null, ref: > backup_destinations.id]",
    "repository_id bigint [not null, ref: > backup_repositories.id]",
    "restic_snapshot_id text [not null]",
    "scope_type text [not null, note: 'hosting_account|website|database|server_config|panel']", "scope_id bigint",
    "hosting_account_id bigint [ref: > hosting_accounts.id]",
    "website_id bigint [ref: > websites.id]",
    "databases text[] [not null, default: `'{}'`]",
    "contents text[] [not null, default: `'{}'`, note: 'files|databases|config']",
    "tags text[] [not null, default: `'{}'`]", "size_bytes bigint",
    "panel_version text", "meta jsonb [note: 'itso-meta.json: phiên bản panel, account, website, DB, gói, manifest sha256']",
    "locked_until timestamptz [note: 'Object Lock/append-only: không xóa được trước mốc này']",
    "job_id bigint [ref: > jobs.id]",
    "taken_at timestamptz [not null]", "verified_at timestamptz",
], ["(repository_id, restic_snapshot_id) [unique]", "(hosting_account_id, taken_at)", "(destination_id, taken_at)"])
t("backup", "backup_verifications", IDN + [
    "uuid uuid [not null, unique, default: `gen_random_uuid()`]",
    "destination_id bigint [not null, ref: > backup_destinations.id]",
    "repository_id bigint [ref: > backup_repositories.id]",
    "hosting_account_id bigint [ref: > hosting_accounts.id]",
    "snapshot_id bigint [ref: > backup_snapshots.id]",
    "kind text [not null, note: 'check|restore_test']",
    "state text [not null, default: 'running', note: 'running|succeeded|failed']",
    "read_data_percent int", "files_checked int", "mismatches int [not null, default: 0]",
    "error text", "job_id bigint [ref: > jobs.id]",
    "started_at timestamptz [not null, default: `now()`]", "finished_at timestamptz",
], ["(destination_id, started_at)", "repository_id"])
t("backup", "restore_jobs", ID + [
    "snapshot_id bigint [ref: > backup_snapshots.id, note: 'null khi snapshot nguồn đã bị forget sau đó']",
    "hosting_account_id bigint [ref: > hosting_accounts.id]",
    "target_type text [not null, note: 'hosting_account (nhân bản: account khác cùng máy)']",
    "target_id bigint", "target_server_id bigint [ref: > servers.id]",
    "mode text [not null, default: 'new', note: 'new|overwrite']",
    "items text[] [not null, default: `'{}'`, note: 'files:<rel>|database:<name>|config']",
    "job_id bigint [ref: > jobs.id]", "status text [not null, default: 'queued']",
    "result jsonb [note: '{restored_paths, databases, pre_restore_snapshot_uuid}']", "error text",
    "pre_restore_snapshot_id bigint [ref: > backup_snapshots.id]",
    "requested_by_user_id bigint [not null, ref: > users.id]", "finished_at timestamptz",
] + TS, ["hosting_account_id"])

# ---------------------------------------------------------------- Jobs
t("jobs", "jobs", ID + [
    "type text [not null]", "server_id bigint [ref: > servers.id]",
    "resource_type text", "resource_id bigint",
    "requested_by_user_id bigint [ref: > users.id]", "idempotency_key text",
    "state text [not null, default: 'queued', note: 'queued|running|succeeded|failed|cancel_requested|cancelled|timed_out']",
    "progress smallint [not null, default: 0]", "attempts int [not null, default: 0]",
    "max_attempts int [not null, default: 3]", "timeout_sec int [not null, default: 600]",
    "error_code text", "error_message text", "parent_job_id bigint [ref: > jobs.id]",
    "started_at timestamptz", "finished_at timestamptz",
] + TS, ["(requested_by_user_id, idempotency_key) [unique]", "(state, created_at)",
         "(resource_type, resource_id)"])
t("jobs", "job_steps", IDN + [
    "job_id bigint [not null, ref: > jobs.id]", "seq int [not null]", "op text [not null]",
    "op_id text [not null, unique]", "params_redacted jsonb [not null, default: `'{}'::jsonb`]",
    "state text [not null, default: 'pending']", "attempts int [not null, default: 0]",
    "result jsonb", "compensation_op text", "started_at timestamptz", "finished_at timestamptz",
], ["(job_id, seq) [unique]"])
t("jobs", "job_logs", IDN + [
    "job_id bigint [not null, ref: > jobs.id]", "step_id bigint [ref: > job_steps.id]",
    "level text [not null]", "message text [not null]", "at timestamptz [not null, default: `now()`]",
], ["(job_id, at)"])

# ---------------------------------------------------------------- Security & audit
t("security", "audit_logs", [
    "id bigint [increment]", "at timestamptz [not null, default: `now()`]",
    "actor_user_id bigint [ref: > users.id]", "impersonator_user_id bigint [ref: > users.id]",
    "actor_ip inet", "user_agent text", "action text [not null]",
    "resource_type text", "resource_id bigint", "server_id bigint",
    "job_id bigint", "changes jsonb", "result text [not null, default: 'success']",
    "prev_hash text", "hash text",
], ["(id, at) [pk]", "(actor_user_id, at)", "(resource_type, resource_id)"],
  "Append-only (trigger), partition theo tháng (extras.sql).")
t("security", "security_events", ID + [
    "server_id bigint [ref: > servers.id]", "website_id bigint [ref: > websites.id]",
    "type text [not null]", "severity text [not null, note: 'info|low|medium|high|critical']",
    "source_ip inet", "message text [not null, default: '']", "details jsonb", "acknowledged_by_user_id bigint [ref: > users.id]",
    "acknowledged_at timestamptz",
    "at timestamptz [not null, default: `now()`]",
], ["(server_id, at)", "(severity, at)"])
t("security", "firewall_rules", ID + [
    "server_id bigint [not null, ref: > servers.id]", "priority int [not null, default: 100]",
    "action text [not null, note: 'accept|drop|reject']", "direction text [not null, default: 'in', note: 'in|out']",
    "protocol text [not null, default: 'tcp', note: 'tcp|udp|icmp|any']", "enabled boolean [not null, default: true]",
    "port_range text", "source_cidr cidr", "comment text",
    "managed_by text [not null, default: 'user', note: 'system|user']",
] + TS, ["(server_id, priority)"])
t("security", "malware_scans", ID + [
    "server_id bigint [not null, ref: > servers.id]", "hosting_account_id bigint [ref: > hosting_accounts.id]",
    "website_id bigint [ref: > websites.id]", "job_id bigint [ref: > jobs.id]",
    "status text [not null, note: 'JobState']", "target text [not null, default: '.', note: 'RelPath trong home account']",
    "engines text[] [not null, default: `'{clamav,yara}'`]", "files_scanned int", "findings_count int",
    "started_at timestamptz", "finished_at timestamptz",
])
t("security", "malware_findings", ID + [
    "scan_id bigint [not null, ref: > malware_scans.id]", "path text [not null]",
    "signature text [not null]", "engine text [not null, note: 'clamav|yara']",
    "sha256 text [not null]", "size bigint [not null, default: 0]",
    "found_at timestamptz [not null, default: `now()`]",
    "action text [not null, default: 'none', note: 'none|quarantined|restored|deleted']",
], ["scan_id"])
t("security", "quarantine_items", ID + [
    "finding_id bigint [ref: > malware_findings.id]", "hosting_account_id bigint [ref: > hosting_accounts.id]",
    "original_path text [not null]", "stored_path text [not null, note: 'id file trên agent: /var/lib/itso/quarantine/<uuid>.bin']",
    "sha256 text [not null]", "signature text [not null, default: '']", "size bigint [not null, default: 0]",
    "quarantined_at timestamptz [not null, default: `now()`]", "restored_at timestamptz",
])
t("security", "fim_baselines", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "path text [not null]",
    "sha256 text [not null]", "mode int", "owner text", "updated_at timestamptz [not null, default: `now()`]",
], ["(server_id, path) [unique]"])
t("security", "firewall_applies", ID + [
    "server_id bigint [not null, ref: > servers.id]",
    "target text [not null, note: 'firewall|sshd (safe-apply chung, D-76/D-77)']",
    "user_id bigint [ref: > users.id]", "client_ip inet [not null]",
    "token_hash text [note: 'sha256 của token xác nhận do agent sinh; không lưu token thô']",
    "spec jsonb [not null, default: `'{}'::jsonb`, note: 'Rule/khóa sshd đã áp dụng']",
    "previous jsonb [note: 'Cấu hình trước đó (để hiển thị khi hoàn tác)']",
    "ruleset_sha256 text",
    "status text [not null, default: 'pending_confirm', note: 'pending_confirm|confirmed|rolled_back|failed']",
    "deadline_at timestamptz [not null]", "confirmed_at timestamptz", "rolled_back_at timestamptz",
    "job_id bigint [ref: > jobs.id]",
    "created_at timestamptz [not null, default: `now()`]",
], ["(server_id, created_at)", "(status, deadline_at)"])
t("security", "security_settings", [
    "server_id bigint [pk, ref: - servers.id]",
    "ssh jsonb [not null, default: `'{}'::jsonb`, note: 'Desired: khóa sshd_config.d/10-itso-hardening.conf']",
    "fail2ban jsonb [not null, default: `'{}'::jsonb`, note: 'Desired: jail sshd|itso-panel|pure-ftpd']",
    "audit_facts jsonb [note: 'Kết quả security.audit gần nhất']", "audited_at timestamptz",
    "score int", "score_items jsonb", "scored_at timestamptz",
    "fim_baseline_at timestamptz", "fim_checked_at timestamptz",
    "waf_events_cursor text [note: 'Con trỏ waf.events của agent']",
] + TS)
t("security", "waf_settings", [
    "website_id bigint [pk, ref: - websites.id]",
    "mode text [not null, default: 'DetectionOnly', note: 'DetectionOnly|On|Off (D-78)']",
    "paranoia_level smallint [not null, default: 1]",
    "rule_exclusions int[] [not null, default: `'{}'`]",
    "detection_since timestamptz [note: 'Mốc bắt đầu DetectionOnly; sau 7 ngày nhắc chuyển On']",
    "auto_block boolean [not null, default: false]",
    "available boolean [not null, default: true, note: 'false khi máy chủ thiếu gói ModSecurity/CRS']",
    "applied_at timestamptz",
] + TS)
t("security", "waf_events", [
    "id bigint [increment]", "uuid uuid [not null, default: `gen_random_uuid()`, note: 'Không unique toàn cục được trên bảng partition; tra kèm website']",
    "at timestamptz [not null]",
    "website_id bigint [not null, ref: > websites.id]", "rule_id int [not null]",
    "severity text [not null]", "action text [not null, note: 'detected|blocked']",
    "client_ip inet", "method text", "uri text", "message text",
], ["(id, at) [pk]", "(website_id, at)"], "Partition theo tháng như audit_logs (extras.sql).")
t("security", "fim_changes", ID + [
    "server_id bigint [not null, ref: > servers.id]", "path text [not null]",
    "change text [not null, note: 'added|modified|removed|metadata']",
    "old_sha256 text", "new_sha256 text", "mode int", "owner text",
    "detected_at timestamptz [not null, default: `now()`]",
    "acknowledged_by_user_id bigint [ref: > users.id]", "acknowledged_at timestamptz",
], ["(server_id, detected_at)"])
t("security", "terminal_recordings", [
    "terminal_session_id bigint [pk, ref: - terminal_sessions.id]",
    "mode text [not null, note: 'account|root']", "client_ip inet",
    "stored_ref text [not null, note: 'Tên file trên agent: /var/lib/itso/recordings/<session_uuid>.cast']",
    "bytes bigint [not null, default: 0]", "width int", "height int",
    "truncated boolean [not null, default: false]",
    "created_at timestamptz [not null, default: `now()`]",
])

# ---------------------------------------------------------------- Notifications, settings, monitoring
t("ops", "notifications", IDN + [
    "user_id bigint [not null, ref: > users.id]", "type text [not null]", "title text [not null]",
    "body text", "data jsonb", "read_at timestamptz",
    "created_at timestamptz [not null, default: `now()`]",
], ["(user_id, read_at)"])
t("ops", "notification_channels", ID + [
    "type text [not null, note: 'email|telegram|webhook (D-103)']", "name text [not null, unique]",
    "config jsonb [not null, default: `'{}'`, note: 'recipients | chat_id | url, allow_private_network — không chứa bí mật']",
    "secret_encrypted text [note: 'Crypt: bot token / HMAC secret; API chỉ trả secret_set']",
    "enabled boolean [not null, default: true]",
    "created_by_user_id bigint [ref: > users.id]",
] + TS)
t("ops", "notification_preferences", [
    "user_id bigint [not null, ref: > users.id]", "event_type text [not null]",
    "channels text[] [not null, default: `'{in_app}'`]",
    "updated_at timestamptz [not null, default: `now()`]",
], ["(user_id, event_type) [pk]"], "D-104: người × sự kiện × kênh; mức critical luôn in-app (kiểm ở ứng dụng).")
t("ops", "notification_deliveries", ID + [
    "channel_id bigint [not null, ref: > notification_channels.id]",
    "alert_id bigint [ref: > alerts.id]",
    "event_type text [not null]", "severity text [not null]", "title text [not null]",
    "payload jsonb [not null, default: `'{}'`, note: 'Nội dung đã dựng, không chứa bí mật']",
    "state text [not null, default: 'queued', note: 'queued|sending|sent|retrying|failed|blocked']",
    "attempts int [not null, default: 0]", "error text", "next_retry_at timestamptz", "sent_at timestamptz",
    "resend_of_id bigint [ref: > notification_deliveries.id]",
] + TS, ["(channel_id, created_at)", "(state, next_retry_at)"])
t("ops", "settings", IDN + [
    "group_key text [not null]", "key text [not null]", "value jsonb",
    "is_encrypted boolean [not null, default: false]", "updated_by_user_id bigint [ref: > users.id]",
] + TS, ["(group_key, key) [unique]"])
t("ops", "metric_samples", [
    "server_id bigint [not null]", "hosting_account_id bigint", "metric text [not null]",
    "value float8 [not null]", "at timestamptz [not null]",
], ["(server_id, metric, at)"], "Partition theo ngày, giữ 7 ngày (extras.sql). Không FK để ghi nhanh.")
t("ops", "metric_rollups", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "hosting_account_id bigint [ref: > hosting_accounts.id]",
    "metric text [not null]", "bucket timestamptz [not null, note: 'Đầu giờ (UTC)']",
    "min_value float8 [not null]", "avg_value float8 [not null]", "max_value float8 [not null]",
    "samples int [not null]",
], ["(server_id, metric, bucket)", "(hosting_account_id, metric, bucket)"],
  "D-101: rollup 1 giờ, giữ 90 ngày; unique (server, account, metric, bucket) NULLS NOT DISTINCT ở extras.sql.")
t("ops", "alert_rules", ID + [
    "name text [not null]", "metric text [not null]", "operator text [not null]",
    "threshold float8 [not null]", "duration_sec int [not null, default: 300]",
    "repeat_sec int [not null, default: 14400]",
    "severity text [not null, default: 'medium']",
    "scope_type text [not null, default: 'server', note: 'server|hosting_account|website']", "scope_id bigint",
    "channels text[] [not null, default: `'{in_app}'`]",
    "channel_ids bigint[] [not null, default: `'{}'`, note: 'notification_channels dùng khi channels có telegram/webhook/email']",
    "is_default boolean [not null, default: false]", "default_key text [unique, note: 'Khóa rule mặc định (seed)']",
    "enabled boolean [not null, default: true]",
] + TS)
t("ops", "alerts", ID + [
    "rule_id bigint [not null, ref: > alert_rules.id]", "server_id bigint [ref: > servers.id]",
    "hosting_account_id bigint [ref: > hosting_accounts.id]", "website_id bigint [ref: > websites.id]",
    "fingerprint text [not null, note: 'rule + đối tượng; unique khi chưa resolved (extras.sql)']",
    "state text [not null, note: 'pending|firing|resolved']", "severity text [not null]",
    "value float8", "message text",
    "started_at timestamptz [not null]", "firing_at timestamptz", "resolved_at timestamptz",
    "below_count int [not null, default: 0, note: 'Số lượt liên tiếp dưới ngưỡng (resolve sau 2)']",
    "acked_by_user_id bigint [ref: > users.id]", "acked_at timestamptz",
    "silenced_until timestamptz", "silence_reason text", "last_notified_at timestamptz",
] + TS, ["(rule_id, started_at)", "(state, started_at)"])
t("ops", "uptime_checks", ID + [
    "website_id bigint [not null, unique, ref: > websites.id]", "path text [not null, default: '/']",
    "keyword text", "interval_sec int [not null, default: 60]", "enabled boolean [not null, default: true]",
    "state text [not null, default: 'unknown', note: 'up|down|unknown']",
    "consecutive_failures int [not null, default: 0]", "last_status int", "last_latency_ms int", "last_error text",
    "last_checked_at timestamptz", "down_since timestamptz", "cert_expires_at timestamptz",
] + TS)
t("ops", "uptime_results", [
    "check_id bigint [not null]", "ok boolean [not null]", "status int", "latency_ms int", "error text",
    "at timestamptz [not null]",
], ["(check_id, at)"], "D-105: partition theo ngày, giữ 7 ngày (extras.sql). Không FK để ghi nhanh.")
t("ops", "uptime_rollups", IDN + [
    "check_id bigint [not null, ref: > uptime_checks.id]", "bucket timestamptz [not null, note: 'Đầu giờ (UTC)']",
    "ok_count int [not null]", "total int [not null]", "avg_latency_ms int",
], ["(check_id, bucket) [unique]"], "D-105: % uptime theo giờ (từ uptime_results), giữ 90 ngày cho % 30 ngày; itso:metrics-rollup.")

GROUP_NAMES = {
    "identity": "Danh tính và phân quyền", "infra": "Hạ tầng", "hosting": "Hosting",
    "docker": "Docker (chỉ admin)", "backup": "Backup và Restore", "jobs": "Jobs",
    "security": "Bảo mật và Audit", "ops": "Thông báo, Cài đặt, Giám sát",
}


REF = re.compile(r"ref: [<>-] (\w+)\.(\w+)")


def render_group(group):
    """DBML con cho ERD theo nhóm: bảng trong nhóm + bảng ngoài nhóm được tham chiếu (chỉ cột khóa)."""
    names = {n for g, n, *_ in tables if g == group}
    types = {}
    for _, n, cols, *_ in tables:
        for c in cols:
            col, typ = c.split()[:2]
            types[(n, col)] = typ
    out, stubs = [f"// ERD nhóm {group} — sinh tự động, không commit.", ""], {}
    for g, name, cols, _idx, _note in tables:
        if g != group:
            continue
        out.append(f"Table {name} {{")
        for c in cols:
            for m in REF.finditer(c):
                if m.group(1) not in names:
                    stubs.setdefault(m.group(1), set()).add(m.group(2))
            out.append(f"  {c.split(' [')[0]}" + ("" if "ref:" not in c and "pk" not in c else
                       " [" + ", ".join(x.strip() for x in c.split(" [", 1)[1].rstrip("]").split(",")
                                        if x.strip().startswith(("ref:", "pk"))) + "]"))
        out.append("}")
        out.append("")
    for stub, cols in sorted(stubs.items()):
        out.append(f"Table {stub} [headercolor: #94A3B8] {{")
        for col in sorted(cols):
            out.append(f"  {col} {types.get((stub, col), 'bigint')}")
        out.append("}")
        out.append("")
    return "\n".join(out)


def render():
    out = ["// ITSO Panel — đặc tả schema PostgreSQL 16 (phạm vi nội bộ).",
           "// FILE SINH TỰ ĐỘNG từ database/tools/gen_dbml.py — sửa ở đó rồi chạy `make db-schema`.",
           "// Ràng buộc bổ sung (CHECK, partial unique, trigger, partition): database/schema/extras.sql.",
           "",
           "Project itso_panel {",
           "  database_type: 'PostgreSQL'",
           "  Note: 'ITSO Panel — hệ thống quản trị máy chủ và Hosting nội bộ. Xem DATABASE.md.'",
           "}", ""]
    for group, name, cols, idx, note in tables:
        out.append(f"Table {name} {{")
        for c in cols:
            out.append(f"  {c}")
        if idx:
            out.append("  indexes {")
            for i in idx:
                out.append(f"    {i}")
            out.append("  }")
        if note:
            out.append(f"  Note: '{note}'")
        out.append("}")
        out.append("")
    for g, label in GROUP_NAMES.items():
        names = ", ".join(n for gg, n, *_ in tables if gg == g)
        out.append(f"TableGroup {g} [note: '{label}'] {{")
        for gg, n, *_ in tables:
            if gg == g:
                out.append(f"  {n}")
        out.append("}")
        out.append("")
    return "\n".join(out)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--erd-groups":
        # Ghi DBML con theo nhóm vào thư mục tạm để vẽ ERD từng nhóm (make db-erd).
        d = Path(sys.argv[2])
        d.mkdir(parents=True, exist_ok=True)
        for g in GROUP_NAMES:
            (d / f"{g}.dbml").write_text(render_group(g), encoding="utf-8")
        print(" ".join(GROUP_NAMES))
    else:
        OUT.write_text(render(), encoding="utf-8")
        print(f"Đã sinh {OUT} ({len(tables)} bảng)")
