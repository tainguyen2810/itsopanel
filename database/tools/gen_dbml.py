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
    "token_hash text [not null, unique]", "created_by_user_id bigint [not null, ref: > users.id]",
    "expires_at timestamptz [not null]", "used_at timestamptz",
    "used_by_server_id bigint [ref: > servers.id]",
] + TS)
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
    "state text [not null, default: 'preflight', note: 'preflight|syncing|verifying|cutover|completed|rolled_back|failed']",
    "verification jsonb [not null, default: `'{}'::jsonb`, note: 'checksum file, row count, HTTP check']",
    "bytes_synced bigint [not null, default: 0]", "downtime_sec int",
    "job_id bigint [ref: > jobs.id]", "cleanup_after timestamptz",
    "requested_by_user_id bigint [not null, ref: > users.id]",
] + TS, ["hosting_account_id", "state"], "Chuyển account giữa server (D-48).")
t("hosting", "purge_records", IDN + [
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
    "size_mb bigint",
] + DO + TS + SOFT, ["hosting_account_id"])
t("hosting", "database_users", IDN + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "server_id bigint [not null, ref: > servers.id]", "engine text [not null]",
    "username text [not null]", "password_encrypted bytea", "host_pattern text [not null, default: 'localhost']",
    "max_connections int [not null, default: 10]",
] + TS + SOFT, ["(server_id, engine, username) [unique]"])
t("hosting", "database_grants", [
    "database_id bigint [not null, ref: > databases.id]",
    "database_user_id bigint [not null, ref: > database_users.id]",
    "privileges text[] [not null]",
], ["(database_id, database_user_id) [pk]"])
t("hosting", "sftp_accounts", ID + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "username text [not null]", "root_subpath text [not null, default: '']",
    "protocol text [not null, default: 'sftp', note: 'sftp|ftps']",
    "password_hash text", "status text [not null, default: 'active']",
] + TS + SOFT, ["hosting_account_id"])
t("hosting", "ssh_keys", IDN + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]", "name text [not null]",
    "public_key text [not null]", "fingerprint text [not null, unique]",
] + TS)
t("hosting", "cron_jobs", ID + [
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "schedule text [not null]", "command text [not null]", "timeout_sec int [not null, default: 3600]",
    "enabled boolean [not null, default: true]", "last_run_at timestamptz", "last_status text",
] + DO + TS + SOFT, ["hosting_account_id"])
t("hosting", "cron_runs", IDN + [
    "cron_job_id bigint [not null, ref: > cron_jobs.id]", "started_at timestamptz [not null]",
    "finished_at timestamptz", "exit_code int", "output_tail text",
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
t("hosting", "upload_sessions", IDN + [
    "uid text [not null, unique]", "user_id bigint [not null, ref: > users.id]",
    "hosting_account_id bigint [not null, ref: > hosting_accounts.id]",
    "target_path text [not null]", "size_bytes bigint [not null]", "received_bytes bigint [not null, default: 0]",
    "expires_at timestamptz [not null]",
] + TS)
t("hosting", "terminal_sessions", IDN + [
    "user_id bigint [not null, ref: > users.id]", "server_id bigint [not null, ref: > servers.id]",
    "hosting_account_id bigint [ref: > hosting_accounts.id]", "unix_uid int [not null]",
    "started_at timestamptz [not null, default: `now()`]", "ended_at timestamptz", "recording_ref text",
], ["user_id"])
t("hosting", "wordpress_sites", [
    "website_id bigint [pk, ref: - websites.id]", "version text", "admin_user text",
    "auto_update text [not null, default: 'minor']", "hardened boolean [not null, default: false]",
    "components jsonb [not null, default: `'[]'::jsonb`]", "observed_at timestamptz",
])
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
    "daemon_config jsonb [not null, default: `'{}'::jsonb`]", "observed_at timestamptz",
])
t("docker", "registries", ID + [
    "name text [not null, unique]", "url text [not null]", "username text",
    "password_encrypted bytea",
] + TS)
t("docker", "compose_projects", ID + [
    "server_id bigint [not null, ref: > servers.id]", "name text [not null]",
    "current_revision_id bigint [ref: > compose_revisions.id]",
] + DO + TS + SOFT, ["(server_id, name) [unique]"])
t("docker", "compose_revisions", IDN + [
    "project_id bigint [not null, ref: > compose_projects.id]", "yaml text [not null]",
    "validated_yaml text", "validation_report jsonb", "created_by_user_id bigint [ref: > users.id]",
    "created_at timestamptz [not null, default: `now()`]",
], ["project_id"])
t("docker", "containers", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "docker_id text [not null]", "name text [not null]",
    "image text [not null]", "project_id bigint [ref: > compose_projects.id]", "state text",
    "ports jsonb [not null, default: `'[]'::jsonb`]", "observed_at timestamptz [not null]",
], ["(server_id, docker_id) [unique]"], "Cache observed từ agent.")
t("docker", "port_allocations", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "port int [not null]",
    "owner_type text [not null]", "owner_id bigint [not null]",
    "created_at timestamptz [not null, default: `now()`]",
], ["(server_id, port) [unique]"])

# ---------------------------------------------------------------- Backup
t("backup", "backup_destinations", ID + [
    "name text [not null]", "type text [not null, note: 'local|sftp|s3|rest']",
    "config jsonb [not null, default: `'{}'::jsonb`]", "credentials_encrypted bytea",
    "append_only boolean [not null, default: false]", "immutable_days int",
    "hosting_account_id bigint [ref: > hosting_accounts.id, note: 'repo riêng theo account (D-23)']",
    "restic_password_encrypted bytea [not null]",
] + TS + SOFT, ["hosting_account_id"])
t("backup", "backup_policies", ID + [
    "name text [not null]", "scope_type text [not null, note: 'server|hosting_account|website|database|compose|panel']",
    "scope_id bigint", "destination_id bigint [not null, ref: > backup_destinations.id]",
    "schedule text [not null]", "retention jsonb [not null, default: `'{}'::jsonb`]",
    "include_exclude jsonb [not null, default: `'{}'::jsonb`]", "enabled boolean [not null, default: true]",
] + TS + SOFT, ["(scope_type, scope_id)"])
t("backup", "backup_jobs", IDN + [
    "policy_id bigint [ref: > backup_policies.id]", "job_id bigint [ref: > jobs.id]",
    "started_at timestamptz", "finished_at timestamptz", "status text [not null]",
    "bytes_added bigint", "files_new int",
], ["policy_id"])
t("backup", "backup_snapshots", IDN + [
    "destination_id bigint [not null, ref: > backup_destinations.id]",
    "restic_snapshot_id text [not null]", "scope_type text [not null]", "scope_id bigint",
    "hosting_account_id bigint [ref: > hosting_accounts.id]",
    "tags text[] [not null, default: `'{}'`]", "size_bytes bigint",
    "taken_at timestamptz [not null]", "verified_at timestamptz",
], ["(destination_id, restic_snapshot_id) [unique]", "(hosting_account_id, taken_at)"])
t("backup", "backup_verifications", IDN + [
    "destination_id bigint [not null, ref: > backup_destinations.id]",
    "snapshot_id bigint [ref: > backup_snapshots.id]",
    "type text [not null, note: 'check|restore-test']", "status text [not null]",
    "report jsonb", "at timestamptz [not null, default: `now()`]",
], ["destination_id"])
t("backup", "restore_jobs", ID + [
    "snapshot_id bigint [not null, ref: > backup_snapshots.id]", "target_type text [not null]",
    "target_id bigint", "target_server_id bigint [ref: > servers.id]",
    "mode text [not null, default: 'new', note: 'new|overwrite']",
    "job_id bigint [ref: > jobs.id]", "status text [not null, default: 'queued']",
    "requested_by_user_id bigint [not null, ref: > users.id]",
] + TS)

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
t("security", "security_events", IDN + [
    "server_id bigint [ref: > servers.id]", "website_id bigint [ref: > websites.id]",
    "type text [not null]", "severity text [not null, note: 'info|low|medium|high|critical']",
    "source_ip inet", "details jsonb", "acknowledged_by_user_id bigint [ref: > users.id]",
    "at timestamptz [not null, default: `now()`]",
], ["(server_id, at)", "(severity, at)"])
t("security", "firewall_rules", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "priority int [not null, default: 100]",
    "action text [not null, note: 'accept|drop|reject']", "protocol text [not null, default: 'tcp']",
    "port_range text", "source_cidr cidr", "comment text",
    "managed_by text [not null, default: 'user', note: 'system|user']",
] + TS, ["(server_id, priority)"])
t("security", "malware_scans", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "hosting_account_id bigint [ref: > hosting_accounts.id]",
    "website_id bigint [ref: > websites.id]", "job_id bigint [ref: > jobs.id]",
    "status text [not null]", "files_scanned int", "findings_count int",
    "started_at timestamptz", "finished_at timestamptz",
])
t("security", "malware_findings", IDN + [
    "scan_id bigint [not null, ref: > malware_scans.id]", "path text [not null]",
    "signature text [not null]", "engine text [not null, note: 'clamav|yara']",
    "action text [not null, default: 'none', note: 'none|quarantined|restored|deleted']",
], ["scan_id"])
t("security", "quarantine_items", IDN + [
    "finding_id bigint [ref: > malware_findings.id]", "hosting_account_id bigint [ref: > hosting_accounts.id]",
    "original_path text [not null]", "stored_path text [not null]", "sha256 text [not null]",
    "quarantined_at timestamptz [not null, default: `now()`]", "restored_at timestamptz",
])
t("security", "fim_baselines", IDN + [
    "server_id bigint [not null, ref: > servers.id]", "path text [not null]",
    "sha256 text [not null]", "mode int", "owner text", "updated_at timestamptz [not null, default: `now()`]",
], ["(server_id, path) [unique]"])

# ---------------------------------------------------------------- Notifications, settings, monitoring
t("ops", "notifications", IDN + [
    "user_id bigint [not null, ref: > users.id]", "type text [not null]", "title text [not null]",
    "body text", "data jsonb", "read_at timestamptz",
    "created_at timestamptz [not null, default: `now()`]",
], ["(user_id, read_at)"])
t("ops", "notification_channels", IDN + [
    "type text [not null, note: 'email|telegram|webhook']", "name text [not null]",
    "config_encrypted bytea [not null]", "enabled boolean [not null, default: true]",
] + TS)
t("ops", "notification_preferences", [
    "user_id bigint [not null, ref: > users.id]", "event_type text [not null]",
    "channels text[] [not null, default: `'{in_app}'`]",
], ["(user_id, event_type) [pk]"])
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
    "metric text [not null]", "bucket timestamptz [not null]",
    "min_value float8", "avg_value float8", "max_value float8",
], ["(server_id, metric, bucket)"])
t("ops", "alert_rules", IDN + [
    "name text [not null]", "metric text [not null]", "operator text [not null]",
    "threshold float8 [not null]", "duration_sec int [not null, default: 300]",
    "scope_type text", "scope_id bigint", "channels text[] [not null, default: `'{in_app}'`]",
    "enabled boolean [not null, default: true]",
] + TS)
t("ops", "alerts", IDN + [
    "rule_id bigint [not null, ref: > alert_rules.id]", "server_id bigint [ref: > servers.id]",
    "state text [not null, note: 'firing|resolved']", "value float8",
    "started_at timestamptz [not null]", "resolved_at timestamptz",
], ["(rule_id, started_at)"])
t("ops", "uptime_checks", IDN + [
    "website_id bigint [not null, ref: > websites.id]", "url text [not null]",
    "interval_sec int [not null, default: 60]", "last_status int", "last_checked_at timestamptz",
] + TS)


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
