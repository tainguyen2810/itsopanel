"""Bộ dữ liệu demo dùng chung: example trong OpenAPI (Prompt 1.4) và MSW mock (Phase 2).

Một nguồn duy nhất để mọi example nhất quán với nhau (cùng UUID, cùng tên, cùng số liệu).
Xuất ra contracts/examples/demo-dataset.json bởi gen_openapi.py.
"""
from __future__ import annotations

KIND = {k: idx + 1 for idx, k in enumerate("""
user server package package_version account website domain certificate database database_user
sftp ssh_key cron snapshot job restore wordpress notification dns_zone dns_record migration purge
backup_destination backup_policy firewall_rule security_event malware_scan quarantine container compose
audit alert_rule alert api_token session registry upload lifecycle enrollment cron_run software
uptime_check impersonation scope channel""".split())}


def u(kind: str, n: int) -> str:
    """UUID v7 cố định, đọc được: 01938a<kind>-<n>-7000-8000-<kind><n>."""
    k = KIND[kind]
    return f"01938a{k:02x}-{n:04x}-7000-8000-{k:06x}{n:06x}"


T0 = "2026-11-18T09:30:00+07:00"
T1 = "2026-11-19T14:05:00+07:00"
T2 = "2026-11-20T08:15:00+07:00"
EXP = "2027-02-16T07:00:00+07:00"


def ts(created=T0, updated=T1):
    return {"created_at": created, "updated_at": updated}


def do(status="ready", spec=3, obs=3, drift=None, at=T2):
    return {"status": status, "spec_version": spec, "observed_version": obs, "drift": drift, "observed_at": at}


# ---------------------------------------------------------------- người dùng
USERS = [
    {"uuid": u("user", 1), "realm": "admin", "name": "Quản trị hệ thống", "email": "superadmin@itso.local",
     "role": "SUPER_ADMIN", "status": "active", "mfa_enabled": True, "locale": "vi",
     "timezone": "Asia/Ho_Chi_Minh", "last_login_at": T2, **ts()},
    {"uuid": u("user", 2), "realm": "admin", "name": "Trần Minh", "email": "minh.tran@itso.local",
     "role": "ADMIN", "status": "active", "mfa_enabled": True, "locale": "vi",
     "timezone": "Asia/Ho_Chi_Minh", "last_login_at": T1, **ts()},
    {"uuid": u("user", 3), "realm": "portal", "name": "Công ty An Phát", "email": "it@anphat.vn",
     "role": "USER", "status": "active", "mfa_enabled": True, "locale": "vi",
     "timezone": "Asia/Ho_Chi_Minh", "last_login_at": T2, **ts()},
    {"uuid": u("user", 4), "realm": "portal", "name": "Phòng Marketing", "email": "marketing@itso.vn",
     "role": "USER", "status": "active", "mfa_enabled": False, "locale": "vi",
     "timezone": "Asia/Ho_Chi_Minh", "last_login_at": T1, **ts()},
    {"uuid": u("user", 5), "realm": "portal", "name": "Lê Hoa", "email": "hoa.le@example.vn",
     "role": "USER", "status": "locked", "mfa_enabled": False, "locale": "en",
     "timezone": "Asia/Ho_Chi_Minh", "last_login_at": None, **ts()},
]


def user_ref(idx):
    x = USERS[idx]
    return {"uuid": x["uuid"], "name": x["name"], "email": x["email"]}


# ---------------------------------------------------------------- server
SERVERS = [
    {"uuid": u("server", 1), "name": "srv-hn-01", "hostname": "srv-hn-01.itso.local",
     "ip_addresses": ["10.10.1.11", "203.0.113.11"], "role_tags": ["web", "db"],
     "os": "Ubuntu 24.04.1 LTS", "kernel": "6.8.0-48-generic", "agent_version": "0.1.0",
     "agent_connected": True, "accepting_new_accounts": True,
     "resources": {"cpu_cores": 16, "ram_mb": 65536, "disk_mb": 1907729, "cpu_pct": 37.5,
                   "ram_used_mb": 28100, "disk_used_mb": 812400, "load_1m": 2.31, "uptime_sec": 3888000},
     "account_count": 2, **do(), **ts()},
    {"uuid": u("server", 2), "name": "srv-hn-02", "hostname": "srv-hn-02.itso.local",
     "ip_addresses": ["10.10.1.12"], "role_tags": ["web"],
     "os": "Ubuntu 24.04.1 LTS", "kernel": "6.8.0-48-generic", "agent_version": "0.1.0",
     "agent_connected": True, "accepting_new_accounts": True,
     "resources": {"cpu_cores": 8, "ram_mb": 32768, "disk_mb": 953674, "cpu_pct": 12.0,
                   "ram_used_mb": 6200, "disk_used_mb": 120300, "load_1m": 0.42, "uptime_sec": 864000},
     "account_count": 0, **do(spec=1, obs=1), **ts()},
    {"uuid": u("server", 3), "name": "srv-hcm-01", "hostname": "srv-hcm-01.itso.local",
     "ip_addresses": ["10.20.1.21"], "role_tags": ["web", "backup"],
     "os": "Ubuntu 24.04.1 LTS", "kernel": "6.8.0-45-generic", "agent_version": "0.1.0",
     "agent_connected": True, "accepting_new_accounts": False,
     "resources": {"cpu_cores": 8, "ram_mb": 16384, "disk_mb": 476837, "cpu_pct": 81.2,
                   "ram_used_mb": 14900, "disk_used_mb": 431000, "load_1m": 6.8, "uptime_sec": 1728000},
     "account_count": 2,
     **do(status="degraded", spec=5, obs=4, drift={"nginx.global": "observed khác desired (worker_connections)"}),
     **ts()},
]


def server_ref(idx):
    x = SERVERS[idx]
    return {"uuid": x["uuid"], "name": x["name"]}


# ---------------------------------------------------------------- gói
def limits(disk, inode, cpu, ram, tasks, php, sites, alias, sub, dbs, dbu, ftp, cron, backup, ssh, phpv):
    return {"disk_mb": disk, "inode_limit": inode, "cpu_percent": cpu, "ram_mb": ram, "tasks_max": tasks,
            "php_workers_max": php, "io_weight": 100, "io_read_bps": None, "io_write_bps": None,
            "website_limit": sites, "alias_domain_limit": alias, "subdomain_limit": sub, "database_limit": dbs,
            "db_user_limit": dbu, "ftp_limit": ftp, "cron_limit": cron, "cron_min_interval_min": 5,
            "backup_quota_mb": backup, "backup_retention": {"daily": 7, "weekly": 4, "monthly": 3},
            "ssh_allowed": ssh, "php_versions": phpv, "retention_days_after_terminate": 30}


PACKAGES = [
    {"uuid": u("package", 1), "code": "basic", "name": "Basic", "description": "Website giới thiệu, blog nội bộ",
     "current_version": 2, "is_active": True, "account_count": 1,
     "limits": limits(5120, 150000, 100, 1024, 128, 4, 2, 5, 5, 2, 2, 2, 3, 10240, False, ["8.2", "8.3"]),
     **ts()},
    {"uuid": u("package", 2), "code": "business", "name": "Business", "description": "Website doanh nghiệp, shop nhỏ",
     "current_version": 1, "is_active": True, "account_count": 2,
     "limits": limits(20480, 400000, 200, 4096, 256, 10, 10, 20, 20, 10, 10, 5, 10, 40960, True,
                      ["8.1", "8.2", "8.3"]), **ts()},
    {"uuid": u("package", 3), "code": "pro", "name": "Pro", "description": "Ứng dụng lớn, nhiều website",
     "current_version": 1, "is_active": True, "account_count": 0,
     "limits": limits(102400, 2000000, 400, 8192, 512, 24, 50, 100, 100, 50, 50, 20, 30, 204800, True,
                      ["8.1", "8.2", "8.3", "8.4"]), **ts()},
]

PACKAGE_VERSIONS = [
    {"uuid": u("package_version", 1), "package_uuid": PACKAGES[0]["uuid"], "version": 1,
     "limits": limits(3072, 100000, 100, 1024, 128, 4, 1, 3, 3, 1, 1, 1, 2, 5120, False, ["8.2", "8.3"]),
     "account_count": 0, "created_by": user_ref(0), "created_at": "2026-10-01T10:00:00+07:00"},
    {"uuid": u("package_version", 2), "package_uuid": PACKAGES[0]["uuid"], "version": 2,
     "limits": PACKAGES[0]["limits"], "account_count": 1, "created_by": user_ref(0), "created_at": T0},
    {"uuid": u("package_version", 3), "package_uuid": PACKAGES[1]["uuid"], "version": 1,
     "limits": PACKAGES[1]["limits"], "account_count": 2, "created_by": user_ref(0), "created_at": T0},
]


def pkg_ref(idx, ver):
    x = PACKAGES[idx]
    return {"uuid": x["uuid"], "code": x["code"], "name": x["name"], "version": ver}


# ---------------------------------------------------------------- hosting account
def usage(disk, inode, cpu, ram, sites, dbs, ftp, cron, backup, pkg_idx):
    lim = PACKAGES[pkg_idx]["limits"]
    return {"disk_mb": {"used": disk, "limit": lim["disk_mb"]},
            "inodes": {"used": inode, "limit": lim["inode_limit"]},
            "cpu_percent": {"used": cpu, "limit": lim["cpu_percent"]},
            "ram_mb": {"used": ram, "limit": lim["ram_mb"]},
            "websites": {"used": sites, "limit": lim["website_limit"]},
            "databases": {"used": dbs, "limit": lim["database_limit"]},
            "ftp_accounts": {"used": ftp, "limit": lim["ftp_limit"]},
            "cron_jobs": {"used": cron, "limit": lim["cron_limit"]},
            "backup_mb": {"used": backup, "limit": lim["backup_quota_mb"]},
            "bandwidth_mb_30d": 48213, "measured_at": T2}


ACCOUNTS = [
    {"uuid": u("account", 1), "username": "anphat", "server": server_ref(0), "package": pkg_ref(1, 1),
     "owner": user_ref(2), "uid": 20001, "home_path": "/home/anphat", "lifecycle_state": "active",
     "suspended_reason": None, "terminated_at": None, "purge_after": None, "legal_hold": False,
     "usage": usage(8420, 120400, 35, 1830, 2, 2, 1, 2, 12800, 1), **do(), **ts()},
    {"uuid": u("account", 2), "username": "mktitso", "server": server_ref(0), "package": pkg_ref(0, 2),
     "owner": user_ref(3), "uid": 20002, "home_path": "/home/mktitso", "lifecycle_state": "active",
     "suspended_reason": None, "terminated_at": None, "purge_after": None, "legal_hold": False,
     "usage": usage(4710, 140100, 22, 610, 1, 1, 1, 1, 6100, 0), **do(), **ts()},
    {"uuid": u("account", 3), "username": "lehoa", "server": server_ref(2), "package": pkg_ref(1, 1),
     "owner": user_ref(4), "uid": 20001, "home_path": "/home/lehoa", "lifecycle_state": "suspended",
     "suspended_reason": "Website bị nhiễm mã độc, chờ làm sạch", "terminated_at": None, "purge_after": None,
     "legal_hold": False, "usage": usage(2100, 50300, 0, 0, 1, 1, 0, 0, 3000, 1), **do(status="suspended"),
     **ts()},
    {"uuid": u("account", 4), "username": "oldshop", "server": server_ref(2), "package": pkg_ref(1, 1),
     "owner": user_ref(2), "uid": 20003, "home_path": "/home/oldshop", "lifecycle_state": "terminated",
     "suspended_reason": None, "terminated_at": "2026-11-01T10:00:00+07:00",
     "purge_after": "2026-12-01T10:00:00+07:00", "legal_hold": False,
     "usage": usage(950, 21000, 0, 0, 0, 0, 0, 0, 1200, 1), **do(status="suspended"), **ts()},
]


def acc_ref(idx):
    x = ACCOUNTS[idx]
    return {"uuid": x["uuid"], "username": x["username"]}


LIFECYCLE = [
    {"uuid": u("lifecycle", 1), "from_state": None, "to_state": "pending", "reason": "Tạo account",
     "actor": user_ref(0), "job_uuid": None, "at": "2026-10-05T09:00:00+07:00"},
    {"uuid": u("lifecycle", 2), "from_state": "pending", "to_state": "provisioning", "reason": None,
     "actor": user_ref(0), "job_uuid": u("job", 1), "at": "2026-10-05T09:00:02+07:00"},
    {"uuid": u("lifecycle", 3), "from_state": "provisioning", "to_state": "active", "reason": None,
     "actor": None, "job_uuid": u("job", 1), "at": "2026-10-05T09:01:10+07:00"},
]

# ---------------------------------------------------------------- website & domain
WEBSITES = [
    {"uuid": u("website", 1), "hosting_account": acc_ref(0), "server": server_ref(0), "primary_domain": "anphat.vn",
     "type": "php", "document_root": "public", "php_version": "8.3", "ssl_mode": "acme", "waf_enabled": True,
     "domains_count": 2, "certificate_expires_at": EXP, **do(), **ts()},
    {"uuid": u("website", 2), "hosting_account": acc_ref(0), "server": server_ref(0),
     "primary_domain": "shop.anphat.vn", "type": "php", "document_root": "public", "php_version": "8.2",
     "ssl_mode": "acme", "waf_enabled": True, "domains_count": 1, "certificate_expires_at": EXP, **do(), **ts()},
    {"uuid": u("website", 3), "hosting_account": acc_ref(1), "server": server_ref(0),
     "primary_domain": "marketing.itso.vn", "type": "static", "document_root": "dist", "php_version": None,
     "ssl_mode": "acme", "waf_enabled": False, "domains_count": 1, "certificate_expires_at": EXP, **do(),
     **ts()},
    {"uuid": u("website", 4), "hosting_account": acc_ref(2), "server": server_ref(2), "primary_domain": "lehoa.blog",
     "type": "php", "document_root": "public", "php_version": "8.1", "ssl_mode": "acme", "waf_enabled": True,
     "domains_count": 1, "certificate_expires_at": "2026-12-02T07:00:00+07:00", **do(status="suspended"),
     **ts()},
]


def site_ref(idx):
    x = WEBSITES[idx]
    return {"uuid": x["uuid"], "primary_domain": x["primary_domain"]}


DOMAINS = [
    {"uuid": u("domain", 1), "website": site_ref(0), "name": "anphat.vn", "type": "primary",
     "verified_at": T0, **ts()},
    {"uuid": u("domain", 2), "website": site_ref(0), "name": "www.anphat.vn", "type": "alias",
     "verified_at": T0, **ts()},
]

CERTS = [
    {"uuid": u("certificate", 1), "website": site_ref(0), "source": "acme", "domains": ["anphat.vn", "www.anphat.vn"],
     "issuer": "Let's Encrypt R11", "not_before": "2026-11-18T07:00:00+07:00", "not_after": EXP,
     "auto_renew": True, "status": "valid", **ts()},
    {"uuid": u("certificate", 2), "website": site_ref(3), "source": "acme", "domains": ["lehoa.blog"],
     "issuer": "Let's Encrypt R10", "not_before": "2026-09-03T07:00:00+07:00",
     "not_after": "2026-12-02T07:00:00+07:00", "auto_renew": True, "status": "expiring", **ts()},
]

DATABASES = [
    {"uuid": u("database", 1), "hosting_account": acc_ref(0), "server": server_ref(0), "engine": "mariadb",
     "name": "anphat_web", "size_mb": 412.5, "charset": "utf8mb4", "users": ["anphat_web"], **do(), **ts()},
    {"uuid": u("database", 2), "hosting_account": acc_ref(0), "server": server_ref(0), "engine": "mariadb",
     "name": "anphat_shop", "size_mb": 1280.0, "charset": "utf8mb4", "users": ["anphat_shop"], **do(), **ts()},
    {"uuid": u("database", 3), "hosting_account": acc_ref(1), "server": server_ref(0), "engine": "postgresql",
     "name": "mktitso_cms", "size_mb": 96.2, "charset": "UTF8", "users": ["mktitso_cms"], **do(), **ts()},
]

DB_USERS = [
    {"uuid": u("database_user", 1), "hosting_account": acc_ref(0), "engine": "mariadb", "username": "anphat_web",
     "host": "localhost", "grants": [{"database": "anphat_web", "privileges": ["ALL"]}], **ts()},
    {"uuid": u("database_user", 2), "hosting_account": acc_ref(0), "engine": "mariadb", "username": "anphat_shop",
     "host": "localhost", "grants": [{"database": "anphat_shop", "privileges": ["SELECT", "INSERT", "UPDATE",
                                                                                 "DELETE"]}], **ts()},
]

FILES = [
    {"name": "public", "path": "sites/anphat.vn/public", "type": "dir", "size": 4096, "mode": "0750",
     "owner": "anphat", "modified_at": T1},
    {"name": "index.php", "path": "sites/anphat.vn/public/index.php", "type": "file", "size": 1734,
     "mode": "0640", "owner": "anphat", "modified_at": T1},
    {"name": ".env", "path": "sites/anphat.vn/.env", "type": "file", "size": 912, "mode": "0600",
     "owner": "anphat", "modified_at": T0},
]

SFTP = [
    {"uuid": u("sftp", 1), "hosting_account": acc_ref(0), "username": "anphat_deploy", "protocol": "sftp",
     "root_path": "sites/anphat.vn", "read_only": False, "last_login_at": T1, **do(), **ts()},
]

SSH_KEYS = [
    {"uuid": u("ssh_key", 1), "hosting_account": acc_ref(0), "name": "Laptop IT An Phát",
     "fingerprint": "SHA256:Qm9sZGx5IGdvIHdoZXJlIG5vIG9uZSBoYXMgZ29uZQ", "type": "ssh-ed25519",
     "last_used_at": T1, **ts()},
]

CRON = [
    {"uuid": u("cron", 1), "hosting_account": acc_ref(0), "website": site_ref(0), "schedule": "*/15 * * * *",
     "command": "php artisan schedule:run", "working_dir": "sites/anphat.vn", "php_version": "8.3",
     "enabled": True, "last_run_at": T2, "last_status": "succeeded", **do(), **ts()},
    {"uuid": u("cron", 2), "hosting_account": acc_ref(0), "website": site_ref(1), "schedule": "0 2 * * *",
     "command": "php bin/cleanup.php", "working_dir": "sites/shop.anphat.vn", "php_version": "8.2",
     "enabled": True, "last_run_at": "2026-11-20T02:00:00+07:00", "last_status": "failed", **do(), **ts()},
]

CRON_RUNS = [
    {"uuid": u("cron_run", 1), "started_at": T2, "finished_at": "2026-11-20T08:15:03+07:00", "exit_code": 0,
     "status": "succeeded", "output_tail": "Running scheduled command: emails:send"},
]

DNS_ZONES = [
    {"uuid": u("dns_zone", 1), "name": "anphat.vn", "provider": "cloudflare", "hosting_account": acc_ref(0),
     "records_count": 6, **ts()},
]

DNS_RECORDS = [
    {"uuid": u("dns_record", 1), "type": "A", "name": "@", "content": "203.0.113.11", "ttl": 300, "proxied": False},
    {"uuid": u("dns_record", 2), "type": "CNAME", "name": "www", "content": "anphat.vn", "ttl": 300,
     "proxied": False},
    {"uuid": u("dns_record", 3), "type": "MX", "name": "@", "content": "mx.anphat.vn", "ttl": 3600,
     "priority": 10, "proxied": False},
]

# ---------------------------------------------------------------- backup
BACKUP_DESTS = [
    {"uuid": u("backup_destination", 1), "name": "Local srv-hn-01", "type": "local", "hosting_account": None,
     "append_only": False, "immutable_days": None, "config": {"path": "/var/backups/itso"},
     "used_mb": 412000, "last_check_at": T2, "last_check_ok": True, **ts()},
    {"uuid": u("backup_destination", 2), "name": "S3 Object Lock (offsite)", "type": "s3", "hosting_account": None,
     "append_only": True, "immutable_days": 30,
     "config": {"endpoint": "https://s3.ap-southeast-1.example.com", "bucket": "itso-backup", "region": "ap-southeast-1"},
     "used_mb": 1830000, "last_check_at": T2, "last_check_ok": True, **ts()},
]

BACKUP_POLICIES = [
    {"uuid": u("backup_policy", 1), "name": "Hằng ngày, tất cả account", "scope_type": "all_accounts",
     "scope_uuid": None, "schedule": "0 1 * * *", "destination_uuids": [BACKUP_DESTS[0]["uuid"], BACKUP_DESTS[1]["uuid"]],
     "retention": {"daily": 7, "weekly": 4, "monthly": 6}, "enabled": True, "last_run_at": "2026-11-20T01:00:00+07:00",
     "last_status": "succeeded", **ts()},
]

SNAPSHOTS = [
    {"uuid": u("snapshot", 1), "hosting_account": acc_ref(0), "destination": {"uuid": BACKUP_DESTS[1]["uuid"],
                                                                           "name": BACKUP_DESTS[1]["name"]},
     "scope_type": "hosting_account", "restic_snapshot_id": "4f2a9c1e", "size_mb": 12800.4,
     "taken_at": "2026-11-20T01:12:00+07:00", "verified_at": "2026-11-20T03:00:00+07:00",
     "contents": ["files", "databases", "config"], "tags": ["daily"]},
    {"uuid": u("snapshot", 2), "hosting_account": acc_ref(3), "destination": {"uuid": BACKUP_DESTS[1]["uuid"],
                                                                           "name": BACKUP_DESTS[1]["name"]},
     "scope_type": "hosting_account", "restic_snapshot_id": "a91b03dd", "size_mb": 1200.0,
     "taken_at": "2026-11-01T10:05:00+07:00", "verified_at": "2026-11-01T11:00:00+07:00",
     "contents": ["files", "databases", "config"], "tags": ["final", "pre-purge"]},
]

RESTORES = [
    {"uuid": u("restore", 1), "snapshot_uuid": SNAPSHOTS[0]["uuid"], "hosting_account": acc_ref(0),
     "target_server": server_ref(0), "mode": "new", "items": ["files:sites/anphat.vn"], "state": "succeeded",
     "job_uuid": u("job", 4), "requested_by": user_ref(2), "created_at": T1, "finished_at": T1},
]

# ---------------------------------------------------------------- migration & purge
MIGRATIONS = [
    {"uuid": u("migration", 1), "hosting_account": acc_ref(2), "source_server": server_ref(2),
     "target_server": server_ref(1), "state": "verifying", "bytes_synced": 2201000000, "downtime_sec": None,
     "verification": {"files": {"checked": 50300, "mismatched": 0}, "databases": {"lehoa_wp": "checksum khớp"},
                      "ssl": "đã sao chép", "cron": "0 job", "ownership": "đã chown theo UID 20004"},
     "job_uuid": u("job", 3), "requested_by": user_ref(0), "cleanup_after": None, **ts()},
]

PURGES = [
    {"uuid": u("purge", 1), "hosting_account": acc_ref(3), "requested_by": user_ref(0), "confirmed_by": None,
     "final_backup_snapshot_uuid": SNAPSHOTS[1]["uuid"], "backup_verified_at": "2026-11-01T11:00:00+07:00",
     "scheduled_for": "2026-12-01T10:00:00+07:00", "completed_at": None, "objects": [], **ts()},
]

# ---------------------------------------------------------------- jobs
JOBS = [
    {"uuid": u("job", 1), "type": "hosting_account.create", "state": "succeeded", "progress": 100,
     "resource": {"type": "hosting_account", "uuid": ACCOUNTS[0]["uuid"]},
     "steps": [{"seq": 1, "op": "account.ensure", "state": "succeeded", "started_at": T0, "finished_at": T0},
               {"seq": 2, "op": "quota.apply", "state": "succeeded", "started_at": T0, "finished_at": T0},
               {"seq": 3, "op": "php.pool.apply", "state": "succeeded", "started_at": T0, "finished_at": T0}],
     "attempts": 1, "max_attempts": 3, "timeout_sec": 600, "error": None, "server": server_ref(0),
     "requested_by": user_ref(0), "created_at": T0, "started_at": T0, "finished_at": T0,
     "links": {"self": f"/api/v1/admin/jobs/{u('job', 1)}", "events": f"/api/v1/admin/jobs/{u('job', 1)}/events"}},
    {"uuid": u("job", 2), "type": "website.create", "state": "running", "progress": 60,
     "resource": {"type": "website", "uuid": WEBSITES[1]["uuid"]},
     "steps": [{"seq": 1, "op": "fs.mkdir", "state": "succeeded", "started_at": T2, "finished_at": T2},
               {"seq": 2, "op": "php.pool.apply", "state": "succeeded", "started_at": T2, "finished_at": T2},
               {"seq": 3, "op": "nginx.vhost.apply", "state": "running", "started_at": T2, "finished_at": None},
               {"seq": 4, "op": "cert.issue", "state": "pending", "started_at": None, "finished_at": None}],
     "attempts": 1, "max_attempts": 3, "timeout_sec": 600, "error": None, "server": server_ref(0),
     "requested_by": user_ref(2), "created_at": T2, "started_at": T2, "finished_at": None,
     "links": {"self": f"/api/v1/admin/jobs/{u('job', 2)}", "events": f"/api/v1/admin/jobs/{u('job', 2)}/events"}},
]

JOB_LOGS = [
    {"seq": 3, "at": T2, "level": "info", "message": "Áp dụng vhost shop.anphat.vn, nginx -t OK"},
    {"seq": 3, "at": T2, "level": "info", "message": "Reload nginx"},
]

# ---------------------------------------------------------------- bảo mật
SECURITY_OVERVIEW = {
    "score": 82, "grade": "B",
    "checks": [
        {"key": "ssh_password_auth", "title": "Tắt đăng nhập SSH bằng mật khẩu", "status": "pass", "severity": "high"},
        {"key": "admin_mfa", "title": "MFA cho mọi quản trị viên", "status": "pass", "severity": "critical"},
        {"key": "backup_offsite", "title": "Backup offsite bất biến", "status": "pass", "severity": "high"},
        {"key": "waf_all_sites", "title": "WAF bật cho mọi website PHP", "status": "warn", "severity": "medium"},
        {"key": "kernel_updates", "title": "Kernel có bản cập nhật bảo mật", "status": "fail", "severity": "high"},
    ],
    "events_24h": {"critical": 0, "high": 2, "medium": 5, "low": 31},
    "blocked_ips_24h": 148, "malware_findings_open": 1, "updated_at": T2,
}

FIREWALL_RULES = [
    {"uuid": u("firewall_rule", 1), "priority": 10, "action": "accept", "direction": "in", "protocol": "tcp",
     "ports": "22", "source": "10.10.0.0/16", "comment": "SSH chỉ từ mạng nội bộ", "enabled": True, **ts()},
    {"uuid": u("firewall_rule", 2), "priority": 20, "action": "accept", "direction": "in", "protocol": "tcp",
     "ports": "80,443", "source": "0.0.0.0/0", "comment": "Web", "enabled": True, **ts()},
    {"uuid": u("firewall_rule", 3), "priority": 30, "action": "accept", "direction": "in", "protocol": "tcp",
     "ports": "8443", "source": "10.10.0.0/16", "comment": "Admin Panel", "enabled": True, **ts()},
]

SECURITY_EVENTS = [
    {"uuid": u("security_event", 1), "type": "waf.block", "severity": "high", "server": server_ref(0),
     "website": site_ref(1), "source_ip": "198.51.100.23",
     "message": "Chặn SQL injection tại /search?q=", "acknowledged_at": None, "at": T2},
    {"uuid": u("security_event", 2), "type": "malware.found", "severity": "high", "server": server_ref(2),
     "website": site_ref(3), "source_ip": None,
     "message": "Phát hiện webshell wp-content/uploads/2026/11/x.php", "acknowledged_at": T1, "at": T1},
]

MALWARE_SCANS = [
    {"uuid": u("malware_scan", 1), "website": site_ref(3), "hosting_account": acc_ref(2), "engine": "clamav+yara",
     "state": "succeeded", "files_scanned": 18230, "findings": 1, "started_at": T1, "finished_at": T1},
]

QUARANTINE = [
    {"uuid": u("quarantine", 1), "hosting_account": acc_ref(2), "original_path": "sites/lehoa.blog/public/wp-content/uploads/2026/11/x.php",
     "sha256": "9f2c4a61b7e0d35a8c1f6e2b4d7a9c0e3f5b8d1a2c4e6f8091a3b5c7d9e1f203", "signature": "PHP.Webshell.Generic",
     "size": 5121, "quarantined_at": T1, "restored_at": None},
]

WAF = {"website": site_ref(0), "enabled": True, "mode": "block", "paranoia_level": 1,
       "rule_exclusions": ["942100"], "blocked_24h": 37, "updated_at": T1}

SSH_SETTINGS = {"port": 22, "password_authentication": False, "permit_root_login": "no",
                "allow_groups": ["itso-ssh"], "max_auth_tries": 3, "updated_at": T0}

FAIL2BAN = {"enabled": True, "jails": [
    {"name": "sshd", "enabled": True, "bantime_sec": 3600, "findtime_sec": 600, "maxretry": 5, "banned_count": 12},
    {"name": "itso-portal-login", "enabled": True, "bantime_sec": 1800, "findtime_sec": 300, "maxretry": 10,
     "banned_count": 3}], "updated_at": T0}

IP_ALLOWLIST = {"entries": [{"cidr": "10.10.0.0/16", "note": "Mạng văn phòng HN"},
                            {"cidr": "10.20.0.0/16", "note": "Mạng văn phòng HCM"}], "updated_at": T0}

# ---------------------------------------------------------------- docker
CONTAINERS = [
    {"id": "3f9a1c2b7d4e", "name": "itso-redis-cache", "image": "redis:7.4-alpine", "state": "running",
     "status": "Up 3 days", "ports": ["127.0.0.1:6380->6379/tcp"], "compose_project": "cache",
     "cpu_pct": 0.8, "mem_mb": 42.0, "created_at": T0},
    {"id": "8b2e4d6f1a3c", "name": "metabase", "image": "metabase/metabase:v0.51.2", "state": "exited",
     "status": "Exited (137) 2 hours ago", "ports": [], "compose_project": "bi", "cpu_pct": 0.0, "mem_mb": 0.0,
     "created_at": T0},
]

COMPOSE = [
    {"uuid": u("compose", 1), "server": server_ref(0), "name": "cache", "status": "running", "services": 1,
     "revision": 3, "validation": {"ok": True, "warnings": []},
     "compose_yaml": "services:\n  redis:\n    image: redis:7.4-alpine\n    command: [\"redis-server\", \"--maxmemory\", \"256mb\"]\n    ports:\n      - \"127.0.0.1:6380:6379\"\n    restart: unless-stopped\n", **ts()},
    {"uuid": u("compose", 2), "server": server_ref(0), "name": "bi", "status": "stopped", "services": 2,
     "revision": 1, "validation": {"ok": True, "warnings": ["Service metabase không giới hạn memory"]},
     "compose_yaml": "services:\n  metabase:\n    image: metabase/metabase:v0.50.0\n    ports:\n      - \"127.0.0.1:3000:3000\"\n    environment:\n      MB_DB_TYPE: postgres\n  postgres:\n    image: postgres:16-alpine\n    volumes:\n      - bi-data:/var/lib/postgresql/data\nvolumes:\n  bi-data: {}\n", **ts()},
]

DOCKER_IMAGES = [{"id": "sha256:1a2b3c4d5e6f", "tags": ["redis:7.4-alpine"], "size_mb": 41.2, "created_at": T0}]
DOCKER_VOLUMES = [{"name": "cache_data", "driver": "local", "size_mb": 120.0, "in_use": True}]
DOCKER_NETWORKS = [{"id": "f1e2d3c4b5a6", "name": "cache_default", "driver": "bridge", "containers": 1}]

REGISTRIES = [{"uuid": u("registry", 1), "name": "GHCR nội bộ", "url": "https://ghcr.io", "username": "itso-bot",
               **ts()}]

# ---------------------------------------------------------------- WordPress
WORDPRESS = [
    {"uuid": u("wordpress", 1), "website": site_ref(3), "hosting_account": acc_ref(2), "wp_version": "6.6.2",
     "latest_version": "6.7.1", "plugins_total": 14, "plugins_outdated": 3, "themes_outdated": 1,
     "auto_update": "minor", "hardening": {"xmlrpc_disabled": True, "file_edit_disabled": True},
     "staging_of": None, "updated_at": T1},
]

# ---------------------------------------------------------------- giám sát, thông báo, audit
METRICS = {"resource": {"type": "server", "uuid": SERVERS[0]["uuid"]}, "metric": "cpu_pct", "step_sec": 300,
           "points": [["2026-11-20T08:00:00+07:00", 31.2], ["2026-11-20T08:05:00+07:00", 36.9],
                      ["2026-11-20T08:10:00+07:00", 42.1], ["2026-11-20T08:15:00+07:00", 37.5]]}

ALERT_RULES = [
    {"uuid": u("alert_rule", 1), "name": "CPU server > 85% trong 10 phút", "metric": "cpu_pct", "scope_type": "server",
     "scope_uuid": None, "operator": "gt", "threshold": 85, "for_sec": 600, "severity": "high",
     "channels": ["email", "telegram"], "enabled": True, **ts()},
]

ALERTS = [
    {"uuid": u("alert", 1), "rule": {"uuid": ALERT_RULES[0]["uuid"], "name": ALERT_RULES[0]["name"]},
     "severity": "high", "state": "firing", "resource": {"type": "server", "uuid": SERVERS[2]["uuid"]},
     "value": 91.3, "started_at": T2, "resolved_at": None},
]

UPTIME = [
    {"uuid": u("uptime_check", 1), "website": site_ref(0), "url": "https://anphat.vn/", "interval_sec": 60,
     "last_status": 200, "last_latency_ms": 182, "uptime_30d": 99.97, "last_checked_at": T2},
]

NOTIFICATIONS = [
    {"uuid": u("notification", 1), "type": "certificate.expiring", "severity": "medium",
     "title": "Chứng chỉ lehoa.blog sắp hết hạn", "body": "Còn 12 ngày, tự gia hạn đang bật.",
     "link": f"/websites/{WEBSITES[3]['uuid']}", "read_at": None, "created_at": T2},
    {"uuid": u("notification", 2), "type": "backup.succeeded", "severity": "info",
     "title": "Backup hằng ngày hoàn tất", "body": "4 account, 23.1 GB, đã kiểm chứng.",
     "link": "/backups", "read_at": T2, "created_at": "2026-11-20T03:05:00+07:00"},
]

NOTIFICATION_PREFS = {"channels": {"email": True, "telegram": False, "in_app": True},
                      "events": {"backup.failed": ["email", "in_app"], "certificate.expiring": ["in_app"],
                                 "security.high": ["email", "in_app"]}, "updated_at": T0}

AUDIT = [
    {"uuid": u("audit", 1), "at": T2, "actor": user_ref(0), "impersonator": None, "actor_ip": "10.10.5.20",
     "action": "hosting_account.suspend", "resource": {"type": "hosting_account", "uuid": ACCOUNTS[2]["uuid"]},
     "server": server_ref(2), "job_uuid": None, "result": "success",
     "changes": {"lifecycle_state": ["active", "suspended"]}, "hash": "5e8f0c6b1d2a7e9f4c3b8a1d6e0f2c7b9a4d1e3f5c7b9d0e2f4a6c8e1b3d5f70"},
]

SETTINGS = {
    "general": {"panel_name": "ITSO Panel", "default_locale": "vi", "timezone": "Asia/Ho_Chi_Minh"},
    "security": {"admin_mfa_required": True, "session_lifetime_min": 120, "portal_captcha_after_failures": 3},
    "smtp": {"host": "smtp.itso.local", "port": 587, "username": "panel@itso.local", "from": "ITSO Panel <panel@itso.local>",
             "encryption": "starttls"},
}

API_TOKENS = [
    {"uuid": u("api_token", 1), "name": "CLI srv-hn-01", "scopes": ["accounts:write", "servers:read"],
     "last_used_at": T2, "expires_at": "2027-05-20T00:00:00+07:00", "created_at": T0},
]

SESSIONS = [
    {"uuid": u("session", 1), "ip": "10.10.5.20", "user_agent": "Firefox 132 / Ubuntu", "current": True,
     "last_active_at": T2, "created_at": T2},
    {"uuid": u("session", 2), "ip": "10.10.5.31", "user_agent": "Chrome 131 / Windows", "current": False,
     "last_active_at": T1, "created_at": T1},
]

ROLES = [
    {"key": "SUPER_ADMIN", "realm": "admin", "name": "Super Admin", "permissions": ["*"]},
    {"key": "ADMIN", "realm": "admin", "name": "Admin",
     "permissions": ["servers.read", "accounts.read", "accounts.write", "websites.*", "databases.*", "backups.read"]},
    {"key": "USER", "realm": "portal", "name": "User", "permissions": ["own.*"]},
]

SCOPES = [{"scope_type": "server", "uuid": SERVERS[0]["uuid"], "name": "srv-hn-01"},
          {"scope_type": "hosting_account", "uuid": ACCOUNTS[2]["uuid"], "name": "lehoa"}]

CAPACITY = {"server": server_ref(0), "cpu_cores": 16, "ram_mb": 65536, "disk_mb": 1907729,
            "allocated_cpu_pct": 300, "allocated_ram_mb": 5120, "allocated_disk_mb": 25600, "account_count": 2,
            "max_accounts": 200, "accepting_new": True, "updated_at": T2}

SERVICES = [
    {"name": "nginx", "active": True, "enabled": True, "version": "1.26.2", "since": T0},
    {"name": "php8.3-fpm", "active": True, "enabled": True, "version": "8.3.13", "since": T0},
    {"name": "mariadb", "active": True, "enabled": True, "version": "11.4.4", "since": T0},
    {"name": "fail2ban", "active": True, "enabled": True, "version": "1.1.0", "since": T0},
]

SOFTWARE = [
    {"key": "nginx", "name": "Nginx", "category": "web", "installed_version": "1.26.2", "latest_version": "1.26.2",
     "state": "installed"},
    {"key": "php8.4", "name": "PHP 8.4", "category": "php", "installed_version": None, "latest_version": "8.4.1",
     "state": "available"},
    {"key": "redis", "name": "Redis", "category": "cache", "installed_version": "7.2.6", "latest_version": "7.4.1",
     "state": "upgradable"},
]

PHP_VERSIONS = [
    {"version": "8.3", "installed": True, "default": True, "sites_count": 1, "extensions": ["intl", "gd", "redis", "zip"]},
    {"version": "8.2", "installed": True, "default": False, "sites_count": 1, "extensions": ["intl", "gd", "zip"]},
]

NGINX_GLOBAL = {"worker_processes": "auto", "worker_connections": 4096, "client_max_body_size": "64m",
                "gzip": True, "http2": True, "server_tokens": False, "updated_at": T0}

ENROLLMENT = {"uuid": u("enrollment", 1), "token": "itso_enr_7Hk2pQ9xVb3mN6tR",
              "command": "curl -fsSL https://admin.itso.local/install.sh | sudo bash -s -- --role node --join itso_enr_7Hk2pQ9xVb3mN6tR",
              "expires_at": "2026-11-20T09:15:00+07:00", "created_at": T2}

PLACEMENT = [
    {"server": server_ref(1), "score": 92, "reasons": ["Còn 89% RAM chưa cấp", "0 account", "Cùng vùng HN"],
     "accepting_new": True},
    {"server": server_ref(0), "score": 71, "reasons": ["Còn 92% RAM chưa cấp", "Disk đã dùng 43%"],
     "accepting_new": True},
]

DASHBOARD = {
    "counts": {"servers": 3, "hosting_accounts": 4, "websites": 4, "databases": 3, "users": 5, "packages": 3},
    "servers": [{"server": server_ref(i), "status": SERVERS[i]["status"], "cpu_pct": SERVERS[i]["resources"]["cpu_pct"],
                 "ram_pct": round(SERVERS[i]["resources"]["ram_used_mb"] * 100 / SERVERS[i]["resources"]["ram_mb"], 1),
                 "disk_pct": round(SERVERS[i]["resources"]["disk_used_mb"] * 100 / SERVERS[i]["resources"]["disk_mb"], 1)}
                for i in range(3)],
    "package_distribution": [{"code": "basic", "accounts": 1}, {"code": "business", "accounts": 3}, {"code": "pro", "accounts": 0}],
    "alerts_firing": 1, "security_events_24h": 38, "jobs_running": 1, "updated_at": T2,
}

PORTAL_OVERVIEW = {
    "accounts": [{"hosting_account": acc_ref(0), "lifecycle_state": "active", "usage": ACCOUNTS[0]["usage"]}],
    "warnings": [{"code": "disk_70", "message": "Dung lượng đã dùng 41% (8.2/20 GB)", "severity": "info"}],
    "recent_jobs": [{"uuid": JOBS[1]["uuid"], "type": "website.create", "state": "running", "progress": 60}],
    "notifications_unread": 1,
}

ME_ADMIN = {"user": USERS[0], "permissions": ["*"], "scopes": [], "mfa_verified_at": T2,
            "impersonating": None}
ME_PORTAL = {"user": USERS[2], "permissions": ["own.*"], "scopes": [], "mfa_verified_at": T2,
             "impersonating": None}

TERMINAL = {"ticket": "tkt_9QwErTy2uIoP", "ws_url": "wss://admin.itso.local/gateway/terminal",
            "expires_at": "2026-11-20T08:15:30+07:00", "mode": "account", "unix_user": "anphat"}

UPLOAD = {"uuid": u("upload", 1), "path": "sites/anphat.vn/public/brochure.pdf", "size": 5242880,
          "chunk_size": 1048576, "received": 0, "expires_at": "2026-11-20T09:15:00+07:00"}

IMPERSONATION = {"uuid": u("impersonation", 1), "staff": user_ref(0), "target": user_ref(2),
                 "reason": "Hỗ trợ cấu hình SSL theo yêu cầu", "started_at": T2,
                 "expires_at": "2026-11-20T08:45:00+07:00", "portal_url": "https://portal.itso.local/?imp=1"}


def dataset() -> dict:
    """Toàn bộ dữ liệu demo theo tên tập."""
    return {k.lower(): v for k, v in globals().items()
            if k.isupper() and not k.startswith("_") and isinstance(v, (list, dict)) and k not in ("KIND",)}


# ================================================================ Phase 2: mở rộng dữ liệu demo
# Phần trên giữ nguyên (example OpenAPI tham chiếu theo chỉ số). Phần dưới thêm bản ghi để mọi trang
# demo có đủ dữ liệu, rồi TÍNH LẠI mọi số tổng hợp từ dữ liệu chi tiết để các trang luôn khớp nhau
# (vd. dashboard "22 website" = danh sách 22 dòng). Kiểm bằng contracts/tools/check_demo.py.

_PORTAL_USERS = [
    ("Công ty Bình Minh", "it@binhminh.vn", "binhminh", "binhminh.vn"),
    ("Trường THPT Sao Mai", "admin@saomai.edu.vn", "saomai", "saomai.edu.vn"),
    ("Phòng Nhân sự ITSO", "hr@itso.vn", "hritso", "tuyendung.itso.vn"),
    ("Nhà thuốc Thiện Tâm", "web@thientam.vn", "thientam", "thientam.vn"),
    ("Cà phê Gió Núi", "hello@gionui.vn", "gionui", "gionui.vn"),
    ("Dự án Cổng nội bộ", "portal@itso.vn", "intranet", "intranet.itso.vn"),
    ("Studio Mây Xanh", "contact@mayxanh.vn", "mayxanh", "mayxanh.vn"),
]
# (tên site phụ, loại, php) cho từng account mới; site đầu tiên dùng domain chính của account.
_EXTRA_SITES = {
    "binhminh": [("shop", "php", "8.3"), ("docs", "static", None)],
    "saomai": [("elearning", "php", "8.2")],
    "hritso": [],
    "thientam": [("dat-lich", "php", "8.3"), ("cdn", "static", None)],
    "gionui": [("menu", "static", None)],
    "intranet": [("wiki", "php", "8.3"), ("api", "proxy", None)],
    "mayxanh": [("portfolio", "static", None), ("blog", "php", "8.3")],
    "pending01": [],
}
_SERVER_OF = {"binhminh": 0, "saomai": 1, "hritso": 1, "thientam": 0, "gionui": 1, "intranet": 0,
              "mayxanh": 1, "pending01": 1}
_PKG_OF = {"binhminh": 1, "saomai": 2, "hritso": 0, "thientam": 1, "gionui": 0, "intranet": 2, "mayxanh": 1,
           "pending01": 0}
_WP = {"blog.mayxanh.vn", "gionui.vn", "saomai.edu.vn", "thientam.vn"}
_DAY = ["2026-11-1%dT%02d:%02d:00+07:00" % (d, h, m) for d, h, m in
        [(2, 9, 10), (3, 10, 20), (4, 11, 30), (5, 14, 0), (6, 15, 45), (7, 16, 5), (8, 8, 40), (9, 13, 15)]]


def _expand() -> None:  # noqa: C901 — một chỗ để đọc toàn bộ quy tắc sinh dữ liệu
    # ---- người dùng: thêm 1 ADMIN có phạm vi + 7 USER
    USERS.append({"uuid": u("user", 6), "realm": "admin", "name": "Phạm Lan", "email": "lan.pham@itso.local",
                  "role": "ADMIN", "status": "active", "mfa_enabled": True, "locale": "vi",
                  "timezone": "Asia/Ho_Chi_Minh", "last_login_at": T2, **ts()})
    for i, (name, email, _, _) in enumerate(_PORTAL_USERS):
        USERS.append({"uuid": u("user", 7 + i), "realm": "portal", "name": name, "email": email,
                      "role": "USER", "status": "active", "mfa_enabled": i % 2 == 0,
                      "locale": "vi" if i != 4 else "en", "timezone": "Asia/Ho_Chi_Minh",
                      "last_login_at": T1 if i % 3 else T2, **ts(_DAY[i], T1)})

    # ---- account mới (8): 7 của user mới + 1 account đang tạo
    owners = {x[2]: 6 + i for i, x in enumerate(_PORTAL_USERS)}
    owners["pending01"] = 3
    uid = 20004
    for n, (username, srv) in enumerate(_SERVER_OF.items()):
        pending = username == "pending01"
        ACCOUNTS.append({
            "uuid": u("account", 5 + n), "username": username, "server": server_ref(srv),
            "package": pkg_ref(_PKG_OF[username], PACKAGES[_PKG_OF[username]]["current_version"]),
            "owner": user_ref(owners[username]), "uid": uid, "home_path": f"/home/{username}",
            "lifecycle_state": "provisioning" if pending else "active", "suspended_reason": None,
            "terminated_at": None, "purge_after": None, "legal_hold": False,
            "usage": usage(0 if pending else 1800 + 950 * n, 0 if pending else 40000 + 9000 * n,
                           0 if pending else 8 + 3 * n, 0 if pending else 300 + 120 * n,
                           0, 0, 0, 0, 0 if pending else 1500 + 700 * n, _PKG_OF[username]),
            **do(status="provisioning" if pending else "ready", spec=1, obs=0 if pending else 1),
            **ts(_DAY[n % len(_DAY)], T1)})
        uid += 1

    # ---- website, domain, chứng chỉ, database, SFTP, cron, snapshot cho account mới
    site_n, db_n, sftp_n, cron_n, snap_n = 5, 4, 2, 3, 3
    for i, (_, _, username, domain) in enumerate(_PORTAL_USERS):
        acc_idx = 4 + i
        names = [(domain, "wordpress" if domain in _WP else "php", "8.3")]
        names += [(f"{sub}.{domain}", "wordpress" if f"{sub}.{domain}" in _WP else t, p)
                  for sub, t, p in _EXTRA_SITES[username]]
        for d, kind, php in names:
            wtype = "php" if kind == "wordpress" else kind
            WEBSITES.append({
                "uuid": u("website", site_n), "hosting_account": acc_ref(acc_idx),
                "server": ACCOUNTS[acc_idx]["server"], "primary_domain": d, "type": wtype,
                "document_root": "dist" if wtype == "static" else "public",
                "php_version": php if wtype == "php" else None, "ssl_mode": "acme", "waf_enabled": wtype == "php",
                "domains_count": 1, "certificate_expires_at": EXP, **do(spec=1, obs=1),
                **ts(_DAY[i], T1)})
            if kind == "wordpress":
                WORDPRESS.append({
                    "uuid": u("wordpress", len(WORDPRESS) + 1), "website": site_ref(len(WEBSITES) - 1),
                    "hosting_account": acc_ref(acc_idx), "wp_version": "6.7.1" if i % 2 else "6.6.2",
                    "latest_version": "6.7.1", "plugins_total": 8 + i, "plugins_outdated": i % 3,
                    "themes_outdated": i % 2, "auto_update": "minor",
                    "hardening": {"xmlrpc_disabled": True, "file_edit_disabled": i % 2 == 1},
                    "staging_of": None, "updated_at": T1})
            site_n += 1
        db = f"{username}_web"
        DATABASES.append({"uuid": u("database", db_n), "hosting_account": acc_ref(acc_idx),
                          "server": ACCOUNTS[acc_idx]["server"], "engine": "mariadb" if i != 5 else "postgresql",
                          "name": db, "size_mb": round(48.5 + 37.25 * i, 2),
                          "charset": "utf8mb4" if i != 5 else "UTF8", "users": [db], **do(spec=1, obs=1),
                          **ts(_DAY[i], T1)})
        DB_USERS.append({"uuid": u("database_user", db_n - 1), "hosting_account": acc_ref(acc_idx),
                         "engine": "mariadb" if i != 5 else "postgresql", "username": db, "host": "localhost",
                         "grants": [{"database": db, "privileges": ["ALL"]}], **ts(_DAY[i], T1)})
        db_n += 1
        SFTP.append({"uuid": u("sftp", sftp_n), "hosting_account": acc_ref(acc_idx), "username": f"{username}_ftp",
                     "protocol": "sftp", "root_path": ".", "read_only": False,
                     "last_login_at": T1 if i % 2 else None, **do(spec=1, obs=1), **ts(_DAY[i], T1)})
        sftp_n += 1
        if i % 2 == 0:
            CRON.append({"uuid": u("cron", cron_n), "hosting_account": acc_ref(acc_idx), "website": None,
                         "schedule": "0 3 * * *", "command": "php wp-cron.php" if domain in _WP else "php artisan backup:clean",
                         "working_dir": ".", "php_version": "8.3", "enabled": True,
                         "last_run_at": "2026-11-20T03:00:00+07:00", "last_status": "succeeded",
                         **do(spec=1, obs=1), **ts(_DAY[i], T1)})
            cron_n += 1
        SNAPSHOTS.append({"uuid": u("snapshot", snap_n), "hosting_account": acc_ref(acc_idx),
                          "destination": {"uuid": BACKUP_DESTS[1]["uuid"], "name": BACKUP_DESTS[1]["name"]},
                          "scope_type": "hosting_account", "restic_snapshot_id": f"{0x5a000000 + 7919 * snap_n:08x}",
                          "size_mb": float(ACCOUNTS[acc_idx]["usage"]["backup_mb"]["used"]),
                          "taken_at": "2026-11-20T01:%02d:00+07:00" % (14 + i), "verified_at": "2026-11-20T03:00:00+07:00",
                          "contents": ["files", "databases", "config"], "tags": ["daily"]})
        snap_n += 1

    # Domain + chứng chỉ cho mọi website chưa có (domain chính; site 1 đã có thêm alias www).
    have_dom = {d["website"]["uuid"] for d in DOMAINS}
    have_cert = {c["website"]["uuid"] for c in CERTS}
    for idx, w in enumerate(WEBSITES):
        if w["uuid"] not in have_dom:
            DOMAINS.append({"uuid": u("domain", len(DOMAINS) + 1), "website": site_ref(idx),
                            "name": w["primary_domain"], "type": "primary", "verified_at": w["created_at"],
                            **ts(w["created_at"], w["updated_at"])})
        if w["ssl_mode"] == "acme" and w["uuid"] not in have_cert:
            exp = w["certificate_expires_at"]
            CERTS.append({"uuid": u("certificate", len(CERTS) + 1), "website": site_ref(idx), "source": "acme",
                          "domains": [w["primary_domain"]], "issuer": "Let's Encrypt R11",
                          "not_before": "2026-11-18T07:00:00+07:00", "not_after": exp, "auto_renew": True,
                          "status": "expiring" if exp.startswith("2026-12") else "valid", **ts()})
        w["domains_count"] = sum(1 for d in DOMAINS if d["website"]["uuid"] == w["uuid"])

    # ---- job, audit, sự kiện bảo mật, thông báo
    job_specs = [
        ("hosting_account.create", "running", 40, "hosting_account", ACCOUNTS[-1]["uuid"], 1,
         [("account.ensure", "succeeded"), ("quota.apply", "running"), ("php.pool.apply", "pending")], None),
        ("website.ssl.renew", "succeeded", 100, "website", WEBSITES[0]["uuid"], 0,
         [("cert.issue", "succeeded"), ("cert.install", "succeeded")], None),
        ("backup.run", "succeeded", 100, "hosting_account", ACCOUNTS[0]["uuid"], 0,
         [("backup.run", "succeeded"), ("backup.check", "succeeded")], None),
        ("database.create", "failed", 50, "database",
         next(d["uuid"] for d in DATABASES if d["name"] == "intranet_web"), 0,
         [("db.pg.create", "succeeded"), ("db.pg.user_ensure", "failed")],
         {"code": "dependency_unavailable", "message": "PostgreSQL không phản hồi trong 30 giây", "step": 2}),
        ("service.restart", "succeeded", 100, "server", SERVERS[2]["uuid"], 2,
         [("service.control", "succeeded")], None),
        ("software.install", "queued", 0, "server", SERVERS[1]["uuid"], 1,
         [("software.install", "pending")], None),
        ("website.create", "succeeded", 100, "website", WEBSITES[-1]["uuid"], 1,
         [("fs.mkdir", "succeeded"), ("php.pool.apply", "succeeded"), ("nginx.vhost.apply", "succeeded"),
          ("cert.issue", "succeeded")], None),
        ("hosting_account.suspend", "succeeded", 100, "hosting_account", ACCOUNTS[2]["uuid"], 2,
         [("account.suspend", "succeeded")], None),
    ]
    for k, (jtype, state, prog, rtype, ruuid, srv, steps, err) in enumerate(job_specs):
        n = 5 + k
        at = _DAY[k % len(_DAY)] if state in ("succeeded", "failed") else T2
        done = state in ("succeeded", "failed")
        JOBS.append({
            "uuid": u("job", n), "type": jtype, "state": state, "progress": prog,
            "resource": {"type": rtype, "uuid": ruuid},
            "steps": [{"seq": s + 1, "op": op, "state": st,
                       "started_at": None if st == "pending" else at,
                       "finished_at": at if st in ("succeeded", "failed") else None}
                      for s, (op, st) in enumerate(steps)],
            "attempts": 1, "max_attempts": 3, "timeout_sec": 600, "error": err, "server": server_ref(srv),
            "requested_by": user_ref(0 if k % 2 == 0 else 1), "created_at": at,
            "started_at": None if state == "queued" else at, "finished_at": at if done else None,
            "links": {"self": f"/api/v1/admin/jobs/{u('job', n)}", "events": f"/api/v1/admin/jobs/{u('job', n)}/events"}})

    actions = [("hosting_account.create", "hosting_account", ACCOUNTS[4]), ("website.create", "website", WEBSITES[6]),
               ("database.create", "database", DATABASES[4]), ("user.update", "user", USERS[7]),
               ("hosting_package.update", "hosting_package", PACKAGES[0]), ("server.update", "server", SERVERS[1]),
               ("backup_policy.update", "backup_policy", BACKUP_POLICIES[0]), ("auth.login", "user", USERS[1]),
               ("firewall.apply", "server", SERVERS[0]), ("website.ssl.renew", "website", WEBSITES[0]),
               ("hosting_account.create", "hosting_account", ACCOUNTS[8]), ("impersonation.start", "user", USERS[2])]
    for k, (action, rtype, obj) in enumerate(actions):
        AUDIT.append({"uuid": u("audit", 2 + k), "at": _DAY[k % len(_DAY)], "actor": user_ref(k % 2),
                      "impersonator": None, "actor_ip": f"10.10.5.{20 + k % 3}", "action": action,
                      "resource": {"type": rtype, "uuid": obj["uuid"]},
                      "server": server_ref(k % 3) if rtype in ("server", "hosting_account", "website", "database") else None,
                      "job_uuid": None, "result": "failure" if action == "auth.login" else "success",
                      "changes": {} if action == "auth.login" else {"updated_at": [T0, T1]},
                      "hash": f"{(0x9e3779b97f4a7c15 * (k + 2)) % (1 << 256):064x}"})

    for k, (etype, sev, srv, site, ip, msg) in enumerate([
        ("waf.block", "medium", 0, 6, "203.0.113.77", "Chặn XSS tại /lien-he"),
        ("ssh.bruteforce", "high", 2, None, "192.0.2.15", "fail2ban chặn IP sau 5 lần đăng nhập SSH sai"),
        ("waf.block", "low", 1, 9, "198.51.100.9", "Chặn quét đường dẫn /wp-login.php"),
        ("login.failed", "medium", 0, None, "203.0.113.200", "Đăng nhập portal sai 3 lần (it@binhminh.vn)"),
        ("fim.change", "high", 2, None, None, "Thay đổi /etc/ssh/sshd_config ngoài panel"),
        ("waf.block", "medium", 0, 1, "198.51.100.23", "Chặn SQL injection tại /cart"),
    ]):
        SECURITY_EVENTS.append({"uuid": u("security_event", 3 + k), "type": etype, "severity": sev,
                                "server": server_ref(srv), "website": site_ref(site) if site is not None else None,
                                "source_ip": ip, "message": msg, "acknowledged_at": None if k % 2 == 0 else T1,
                                "at": _DAY[(k + 3) % len(_DAY)]})

    for k, (ntype, sev, title, body, link) in enumerate([
        ("job.failed", "high", "Tạo database intranet_web thất bại", "PostgreSQL không phản hồi; có thể thử lại.",
         f"/jobs/{u('job', 8)}"),
        ("security.high", "high", "Thay đổi cấu hình SSH ngoài panel", "srv-hcm-01: /etc/ssh/sshd_config.", "/security"),
        ("alert.firing", "high", "CPU srv-hcm-01 vượt 85%", "91,3% trong 12 phút.", "/monitoring/alerts"),
        ("account.created", "info", "Đã tạo account mayxanh", "Gói Business trên srv-hn-02.", f"/hosting-accounts/{u('account', 11)}"),
    ]):
        NOTIFICATIONS.append({"uuid": u("notification", 3 + k), "type": ntype, "severity": sev, "title": title,
                              "body": body, "link": link, "read_at": None if k < 3 else T2, "created_at": T2})

    _recompute()


def _recompute() -> None:
    """Mọi số tổng hợp tính từ dữ liệu chi tiết: không có số viết tay lệch nhau."""
    def count(items, key, uuid):
        return sum(1 for x in items if (x.get(key) or {}).get("uuid") == uuid)

    live = [a for a in ACCOUNTS if a["lifecycle_state"] != "terminated"]
    for a in ACCOUNTS:
        us = a["usage"]
        us["websites"]["used"] = count(WEBSITES, "hosting_account", a["uuid"])
        us["databases"]["used"] = count(DATABASES, "hosting_account", a["uuid"])
        us["ftp_accounts"]["used"] = count(SFTP, "hosting_account", a["uuid"])
        us["cron_jobs"]["used"] = count(CRON, "hosting_account", a["uuid"])
    for s in SERVERS:
        s["account_count"] = sum(1 for a in live if a["server"]["uuid"] == s["uuid"])
    for p in PACKAGES:
        p["account_count"] = sum(1 for a in live if a["package"]["uuid"] == p["uuid"])
    for v in PACKAGE_VERSIONS:
        v["account_count"] = sum(1 for a in live if a["package"]["uuid"] == v["package_uuid"]
                                 and a["package"]["version"] == v["version"])
    for z in DNS_ZONES:
        z["records_count"] = len(DNS_RECORDS)
    CAPACITY["account_count"] = SERVERS[0]["account_count"]

    DASHBOARD["counts"] = {"servers": len(SERVERS), "hosting_accounts": len(live), "websites": len(WEBSITES),
                           "databases": len(DATABASES), "users": len(USERS), "packages": len(PACKAGES)}
    DASHBOARD["package_distribution"] = [{"code": p["code"], "accounts": p["account_count"]} for p in PACKAGES]
    DASHBOARD["alerts_firing"] = sum(1 for a in ALERTS if a["state"] == "firing")
    DASHBOARD["jobs_running"] = sum(1 for j in JOBS if j["state"] == "running")
    DASHBOARD["security_events_24h"] = sum(SECURITY_OVERVIEW["events_24h"].values())

    PORTAL_OVERVIEW["accounts"] = [{"hosting_account": {"uuid": a["uuid"], "username": a["username"]},
                                    "lifecycle_state": a["lifecycle_state"], "usage": a["usage"]}
                                   for a in live if a["owner"]["uuid"] == USERS[2]["uuid"]]
    PORTAL_OVERVIEW["notifications_unread"] = sum(1 for n in NOTIFICATIONS if n["read_at"] is None)


_expand()
