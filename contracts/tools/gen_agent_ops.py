#!/usr/bin/env python3
"""Sinh contracts/agent-ops/*.json: envelope, result, mã lỗi, catalog và schema từng typed operation.

Agent Go validate lại MỌI tham số theo các schema này (không tin panel). Mẫu ràng buộc dùng chung với
OpenAPI lấy từ schemas.PATTERNS để hai phía không lệch nhau.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from schemas import PATTERNS  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "agent-ops"
BASE = "https://schemas.itso.local/agent-ops"
D2020 = "https://json-schema.org/draft/2020-12/schema"


def d(name):
    return {"$ref": f"defs.schema.json#/$defs/{name}"}


def s(**kw):
    return {"type": "string", **kw}


def i(**kw):
    return {"type": "integer", **kw}


def b():
    return {"type": "boolean"}


def arr(items, **kw):
    return {"type": "array", "items": items, **kw}


def enum(*v):
    return {"type": "string", "enum": list(v)}


def obj(props, required=None):
    return {"type": "object", "properties": props, "required": list(props) if required is None else required,
            "additionalProperties": False}


DEFS = {
    **PATTERNS,
    "Uuid": s(pattern="^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
    "Uid": i(minimum=20000, maximum=59999, description="UID hosting account (D-07)."),
    "ServiceName": enum("nginx", "php8.1-fpm", "php8.2-fpm", "php8.3-fpm", "php8.4-fpm", "mariadb", "postgresql",
                        "redis-server", "fail2ban", "cron", "ssh", "itso-gateway"),
    "Sha256": s(pattern="^[0-9a-f]{64}$"),
    "Hostname": s(minLength=1, maxLength=253, pattern="^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$",
                  description="Hostname máy chủ (RFC 1123, chữ thường)."),
    "Recipe": enum("acl", "quota", "nftables", "restic", "stress-ng", "nginx", "php8.3", "lego", "mariadb", "postgresql",
                   "pure-ftpd"),
    "QuotaMode": enum("kernel", "soft"),
    "Mode": s(pattern="^0[0-7]{3}$"),
    "Bytes": i(minimum=0),
    "Limits": obj({"disk_mb": i(minimum=1), "inode_limit": i(minimum=1), "cpu_percent": i(minimum=1, maximum=6400),
                   "ram_mb": i(minimum=64), "tasks_max": i(minimum=16), "io_weight": i(minimum=1, maximum=10000),
                   "io_read_bps": {"type": ["integer", "null"], "minimum": 1},
                   "io_write_bps": {"type": ["integer", "null"], "minimum": 1}}),
    "Account": obj({"username": d("Username"), "uid": d("Uid")}),
    "Email": s(maxLength=190, pattern="^[A-Za-z0-9._%+-]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$"),
    "PhpExtension": enum("bcmath", "curl", "gd", "imagick", "intl", "mbstring", "mysql", "opcache", "pgsql", "redis",
                         "soap", "sqlite3", "xml", "zip"),
    "SiteType": enum("php", "static", "proxy"),
    "AcmeDirectory": enum("letsencrypt", "letsencrypt-staging", "pebble"),
    "CertInfo": obj({"cert_uuid": d("Uuid"), "issuer": s(maxLength=500), "not_before": s(), "not_after": s(),
                     "domains": arr(d("Domain"), maxItems=100)}),
    "DbEngine": enum("mariadb", "mysql", "postgresql"),
    "DbPrivileges": arr(enum("ALL", "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX"), maxItems=9,
                        uniqueItems=True),
    "FileType": enum("file", "dir", "symlink", "other"),
    "BackupRepo": obj({"repo_uuid": d("Uuid"), "destination_type": enum("local", "sftp", "s3", "rest"),
                       "append_only": b()}, required=["repo_uuid", "destination_type"]),
}

# (op, domain, rủi ro, mặc định bật, phase, chạy dưới, timeout_sec, params, result)
A = d("Account")
OPS = [
    # -- system
    ("system.ping", "system", "low", True, 1, "root", 5, obj({}),
     obj({"pong": {"const": True}, "agent_version": s(), "mode": enum("mock", "real", "sandbox")})),
    ("system.info", "system", "low", True, 4, "root", 10, obj({}),
     obj({"os": s(), "kernel": s(), "hostname": s(), "uptime_sec": i(), "cpu_cores": i(), "ram_mb": i(),
          "disk_total_mb": i(), "disk_free_mb": i(), "cgroup_v2": b(), "systemd": b(), "quota_mode": d("QuotaMode"),
          "arch": s()})),
    ("system.hostname.set", "system", "high", True, 4, "root", 30, obj({"hostname": d("Hostname")}),
     obj({"hostname": d("Hostname"), "changed": b()})),
    ("service.status", "system", "low", True, 4, "root", 10, obj({"names": arr(d("ServiceName"), minItems=1)}),
     obj({"services": arr(obj({"name": s(), "active": b(), "enabled": b(), "version": {"type": ["string", "null"]}}))})),
    ("service.control", "system", "high", True, 4, "root", 60,
     obj({"name": d("ServiceName"), "action": enum("start", "stop", "restart", "reload")}), obj({"active": b()})),
    ("system.reboot", "system", "high", True, 4, "root", 30, obj({"delay_sec": i(minimum=0, maximum=600), "reason": s(maxLength=200)}), obj({"scheduled_at": s()})),
    ("metrics.snapshot", "system", "low", True, 4, "root", 10, obj({}), obj({"cpu_pct": {"type": "number"}, "ram_used_mb": i(), "disk_used_mb": i(), "load_1m": {"type": "number"}})),
    ("metrics.cgroup", "system", "low", True, 4, "root", 15, obj({"accounts": arr(A, minItems=1, maxItems=1000)}),
     obj({"accounts": arr(obj({"username": d("Username"), "cpu_usage_usec": i(minimum=0), "cpu_throttled_usec": i(minimum=0),
                                "memory_current_mb": i(minimum=0), "memory_max_mb": {"type": ["integer", "null"]},
                                "pids_current": i(minimum=0), "oom_kills": i(minimum=0)}))})),
    ("audit.tail", "system", "low", True, 4, "root", 15,
     obj({"after_seq": i(minimum=0), "limit": i(minimum=1, maximum=1000)}),
     obj({"entries": arr(obj({"seq": i(minimum=1), "ts": s(), "op": s(), "op_id": s(), "caller_uid": i(minimum=0),
                               "result": enum("ok", "error", "rejected"), "error_code": {"type": ["string", "null"]},
                               "params_hash": d("Sha256"), "prev_hash": d("Sha256"), "hash": d("Sha256")})),
          "chain_ok": b(), "last_seq": i(minimum=0)})),
    ("software.install", "software", "high", True, 4, "root", 900, obj({"recipe": d("Recipe")}),
     obj({"installed": b(), "version": {"type": ["string", "null"]}, "changed": b()})),
    ("software.remove", "software", "high", True, 4, "root", 900, obj({"recipe": d("Recipe")}),
     obj({"installed": b(), "changed": b()})),
    ("op.cancel", "system", "low", True, 4, "root", 5, obj({"op_id": s(minLength=1, maxLength=200)}), obj({"cancelled": b()})),
    # -- account & quota
    ("account.ensure", "account", "high", True, 4, "root", 120,
     obj({"account": A, "home_path": s(pattern="^/home/[a-z][a-z0-9]{2,15}$"), "shell": enum("/usr/sbin/nologin", "/bin/bash"), "limits": d("Limits")}),
     obj({"created": b(), "uid": d("Uid")})),
    ("account.suspend", "account", "high", True, 4, "root", 60, obj({"account": A, "reason": s(maxLength=200)}), obj({"suspended": b()})),
    ("account.unsuspend", "account", "high", True, 4, "root", 60, obj({"account": A}), obj({"suspended": b()})),
    ("account.remove", "account", "critical", True, 8, "root", 1800,
     obj({"account": A, "purge_uuid": d("Uuid"), "final_snapshot_id": s(pattern="^[0-9a-f]{8,64}$"), "confirm_username": d("Username")}),
     obj({"removed_objects": arr(obj({"kind": s(), "name": s(), "sha256": {"type": ["string", "null"]}}))})),
    ("account.limits.apply", "account", "high", True, 4, "root", 60, obj({"account": A, "limits": d("Limits")}),
     obj({"applied": b(), "slice": s(pattern="^itso-acct-[0-9]{5}\\.slice$")})),
    ("quota.apply", "account", "high", True, 4, "root", 60, obj({"account": A, "limits": d("Limits")}),
     obj({"applied": b(), "mode": d("QuotaMode")}, required=["applied"])),
    ("quota.report", "account", "low", True, 4, "root", 60, obj({"accounts": arr(A, maxItems=1000)}),
     obj({"usage": arr(obj({"username": d("Username"), "disk_mb": i(), "inodes": i(), "cpu_pct": {"type": "number"}, "ram_mb": i()}))})),
    # -- website: thư mục site, vhost, PHP-FPM (D-67, D-68)
    ("fs.site_layout.ensure", "web", "high", True, 5, "root", 60,
     obj({"account": A, "site_dir": d("Domain")}),
     obj({"path": s(), "created": b()})),
    ("nginx.vhost.apply", "web", "high", True, 5, "root", 60,
     obj({"account": A, "website_uuid": d("Uuid"), "site_dir": d("Domain"), "type": d("SiteType"),
          "server_names": arr(d("Domain"), minItems=1, maxItems=100),
          "redirect_names": arr(d("Domain"), maxItems=100),
          "document_root": d("RelPath"),
          "php_socket": {"type": ["string", "null"], "pattern": "^/run/itso/php/[a-z][a-z0-9]{2,15}-[0-9a-f]{8}\\.sock$"},
          "proxy_port": {"type": ["integer", "null"], "minimum": 1024, "maximum": 65535},
          "tls": {"type": ["object", "null"], "properties": {"cert_uuid": d("Uuid"), "hsts": b(), "force_https": b()},
                  "required": ["cert_uuid", "hsts", "force_https"], "additionalProperties": False},
          "http2": b(), "client_max_body_size": d("NginxSize"),
          "extra_headers": {"type": "object", "maxProperties": 20, "additionalProperties": d("HeaderValue"),
                            "propertyNames": {"pattern": "^[A-Za-z][A-Za-z0-9-]{1,63}$"}},
          "redirects": arr(obj({"from": d("UrlPath"), "to": d("RedirectTarget"), "code": enum("301", "302")}), maxItems=100),
          "suspended": b()},
         required=["account", "website_uuid", "site_dir", "type", "server_names", "document_root"]),
     obj({"config_path": s(), "nginx_test": enum("ok"), "reloaded": b(), "changed": b()})),
    ("nginx.vhost.remove", "web", "high", True, 5, "root", 60, obj({"account": A, "website_uuid": d("Uuid")}),
     obj({"removed": b()})),
    ("nginx.vhost.inspect", "web", "low", True, 5, "root", 15, obj({"website_uuid": d("Uuid")}),
     obj({"exists": b(), "config": {"type": ["string", "null"], "maxLength": 65536}, "sha256": {"type": ["string", "null"]}})),
    ("nginx.global.apply", "web", "high", True, 5, "root", 60,
     obj({"worker_processes": s(pattern="^(auto|[0-9]{1,3})$"), "worker_connections": i(minimum=256, maximum=65535),
          "client_max_body_size": d("NginxSize"), "gzip": b(), "http2": b(), "server_tokens": b()}),
     obj({"nginx_test": enum("ok"), "reloaded": b(), "changed": b()})),
    ("php.pool.apply", "web", "high", True, 5, "root", 60,
     obj({"account": A, "website_uuid": d("Uuid"), "site_dir": d("Domain"), "version": d("PhpVersion"),
          "pm_max_children": i(minimum=1, maximum=64), "memory_limit": d("NginxSize"),
          "max_execution_time": i(minimum=1, maximum=600), "upload_max_filesize": d("NginxSize"),
          "disable_functions": arr(s(pattern="^[a-z_0-9]+$"), maxItems=100)}),
     obj({"socket": s(), "unit": s(), "reloaded": b(), "changed": b()})),
    ("php.pool.remove", "web", "high", True, 5, "root", 60, obj({"account": A, "website_uuid": d("Uuid")}),
     obj({"removed": b()})),
    ("php.version.install", "web", "high", True, 5, "root", 1800,
     obj({"version": d("PhpVersion"), "extensions": arr(d("PhpExtension"), maxItems=20)}),
     obj({"installed": b(), "changed": b()})),
    ("php.version.remove", "web", "high", True, 5, "root", 900, obj({"version": d("PhpVersion")}),
     obj({"removed": b()})),
    ("php.ext.install", "web", "medium", True, 5, "root", 900,
     obj({"version": d("PhpVersion"), "extensions": arr(d("PhpExtension"), minItems=1, maxItems=20)}),
     obj({"installed": arr(d("PhpExtension")), "changed": b()})),
    ("log.tail", "web", "low", True, 5, "root", 15,
     obj({"account": A, "site_dir": d("Domain"), "kind": enum("access", "error"), "lines": i(minimum=1, maximum=500)}),
     obj({"lines": arr(s(maxLength=8192), maxItems=500), "truncated": b()})),
    # -- chứng chỉ (D-69)
    ("cert.issue", "cert", "medium", True, 5, "root", 300,
     obj({"account": A, "website_uuid": d("Uuid"), "cert_uuid": d("Uuid"), "site_dir": d("Domain"),
          "domains": arr(d("Domain"), minItems=1, maxItems=100), "challenge": enum("http-01"),
          "email": d("Email"), "directory": d("AcmeDirectory"), "renew": b()}),
     d("CertInfo")),
    ("cert.install", "cert", "medium", True, 5, "root", 60,
     obj({"account": A, "website_uuid": d("Uuid"), "cert_uuid": d("Uuid"),
          "certificate_pem": s(maxLength=65536, pattern="^-----BEGIN CERTIFICATE-----"),
          "private_key_pem": s(maxLength=16384, pattern="^-----BEGIN (EC |RSA )?PRIVATE KEY-----", writeOnly=True)}),
     d("CertInfo")),
    ("cert.inspect", "cert", "low", True, 5, "root", 15, obj({"cert_uuid": d("Uuid")}),
     obj({"exists": b(), "cert": {"oneOf": [d("CertInfo"), {"type": "null"}]}})),
    ("cert.remove", "cert", "medium", True, 5, "root", 60, obj({"account": A, "cert_uuid": d("Uuid")}), obj({"removed": b()})),
    # -- fs (dưới UID account)
    ("fs.list", "fs", "medium", True, 6, "account", 30,
     obj({"account": A, "path": d("RelPath"), "show_hidden": b(), "limit": i(minimum=1, maximum=5000)}, required=["account", "path"]),
     obj({"entries": arr(obj({"name": s(maxLength=255), "type": d("FileType"), "size": d("Bytes"), "mode": d("Mode"),
                              "modified_at": s(), "target": {"type": ["string", "null"], "maxLength": 4096}}), maxItems=5000),
          "truncated": b()})),
    ("fs.stat", "fs", "low", True, 6, "account", 15, obj({"account": A, "path": d("RelPath")}),
     obj({"exists": b(), "type": {"oneOf": [d("FileType"), {"type": "null"}]}, "size": d("Bytes"),
          "mode": {"type": ["string", "null"], "pattern": "^0[0-7]{3}$"}, "modified_at": {"type": ["string", "null"]}})),
    ("fs.read", "fs", "medium", True, 6, "account", 30,
     obj({"account": A, "path": d("RelPath"), "max_bytes": i(minimum=1, maximum=2097152), "offset": i(minimum=0)},
         required=["account", "path", "max_bytes"]),
     obj({"content_b64": s(), "sha256": d("Sha256"), "truncated": b(), "size": d("Bytes"),
          "file_sha256": {"type": ["string", "null"], "pattern": "^[0-9a-f]{64}$",
                          "description": "sha256 cả file khi đọc trọn (offset 0, không cắt) — dùng làm ETag của editor."}})),
    ("fs.write", "fs", "medium", True, 6, "account", 30,
     obj({"account": A, "path": d("RelPath"), "content_b64": s(maxLength=2796204), "if_sha256": {"type": ["string", "null"], "pattern": "^[0-9a-f]{64}$"}, "mode": d("Mode")},
         required=["account", "path", "content_b64"]),
     obj({"sha256": d("Sha256"), "size": d("Bytes")})),
    ("fs.mkdir", "fs", "medium", True, 6, "account", 30, obj({"account": A, "path": d("RelPath"), "mode": d("Mode")}), obj({"created": b()})),
    ("fs.rename", "fs", "medium", True, 6, "account", 30, obj({"account": A, "from": d("RelPath"), "to": d("RelPath")}), obj({"renamed": b()})),
    ("fs.move", "fs", "medium", True, 6, "account", 120, obj({"account": A, "paths": arr(d("RelPath"), minItems=1, maxItems=500), "target": d("RelPath")}), obj({"moved": i()})),
    ("fs.copy", "fs", "medium", True, 6, "account", 600, obj({"account": A, "paths": arr(d("RelPath"), minItems=1, maxItems=500), "target": d("RelPath")}), obj({"copied": i()})),
    ("fs.delete", "fs", "medium", True, 6, "account", 600, obj({"account": A, "paths": arr(d("RelPath"), minItems=1, maxItems=500)}), obj({"deleted": i()})),
    ("fs.chmod", "fs", "medium", True, 6, "account", 120, obj({"account": A, "paths": arr(d("RelPath"), minItems=1, maxItems=500), "mode": d("Mode"), "recursive": b()}), obj({"changed": i()})),
    ("fs.archive", "fs", "medium", True, 6, "account", 1800, obj({"account": A, "paths": arr(d("RelPath"), minItems=1, maxItems=500), "target": d("RelPath"), "format": enum("zip", "tar.gz")}), obj({"size": d("Bytes")})),
    ("fs.extract", "fs", "medium", True, 6, "account", 1800,
     obj({"account": A, "archive": d("RelPath"), "target": d("RelPath"), "max_total_bytes": i(minimum=1, maximum=53687091200),
          "max_entries": i(minimum=1, maximum=200000)}),
     obj({"entries": i(), "size": d("Bytes"), "skipped": i(description="Mục bị bỏ qua: symlink, hardlink, thiết bị")})),
    ("fs.upload.commit", "fs", "medium", True, 6, "account", 1800,
     obj({"account": A, "upload_uuid": d("Uuid"), "target": d("RelPath"), "size": i(minimum=0, maximum=10737418240),
          "overwrite": b()}),
     obj({"size": d("Bytes"), "sha256": d("Sha256")})),
    # -- database (D-71): agent dùng socket/peer auth của root/postgres, không nhận mật khẩu quản trị; dump/import chạy
    #    dưới uid account bằng danh tính chủ (unix_socket/peer), nên SQL trong file không đụng DB của account khác.
    *[(f"db.{eng}.{op}", "db", "high", True, 6, runs, t, p, r) for eng in ("mysql", "pg") for op, runs, t, p, r in [
        ("owner_ensure", "root", 60, obj({"account": A}), obj({"created": b()})),
        ("create", "root", 60, obj({"account": A, "name": d("DbName"), "charset": s(pattern="^[a-zA-Z0-9_]{1,32}$")}), obj({"created": b()})),
        ("drop", "root", 120, obj({"account": A, "name": d("DbName"), "confirm_name": d("DbName")}), obj({"dropped": b()})),
        ("user_ensure", "root", 60, obj({"account": A, "username": d("DbName"), "password": {"oneOf": [d("SecretPassword"), {"type": "null"}]},
                                         "host": enum("localhost", "%"), "max_connections": i(minimum=1, maximum=500)}),
         obj({"created": b(), "changed": b()})),
        ("user_drop", "root", 60, obj({"account": A, "username": d("DbName")}), obj({"dropped": b()})),
        ("grant", "root", 60, obj({"account": A, "username": d("DbName"), "database": d("DbName"), "privileges": d("DbPrivileges")}),
         obj({"granted": b()})),
        ("lock", "root", 60, obj({"account": A, "locked": b()}), obj({"changed": i()})),
        ("inspect", "root", 60, obj({"account": A}),
         obj({"databases": arr(obj({"name": d("DbName"), "size_bytes": d("Bytes")}), maxItems=1000),
              "users": arr(d("DbName"), maxItems=1000)})),
        ("dump", "account", 3600, obj({"account": A, "name": d("DbName"), "target": d("RelPath"), "compress": b()}), obj({"size": d("Bytes"), "sha256": d("Sha256")})),
        ("import", "account", 3600, obj({"account": A, "name": d("DbName"), "source": d("RelPath")}), obj({"bytes": d("Bytes")})),
    ]],
    # -- sftp / ssh / cron
    # -- SFTP/FTPS/SSH (D-73)
    ("sshd.match.apply", "access", "high", True, 6, "root", 60, obj({"password_authentication": b()}),
     obj({"sshd_test": enum("ok"), "reloaded": b(), "changed": b()})),
    ("sftp.user.ensure", "access", "high", True, 6, "root", 60,
     obj({"account": A, "ssh_access": b(), "password": {"oneOf": [d("SecretPassword"), {"type": "null"}]}}),
     obj({"group": enum("itso-sftp", "itso-ssh"), "changed": b()})),
    ("sftp.user.remove", "access", "high", True, 6, "root", 60, obj({"account": A}), obj({"removed": b()})),
    ("ftp.user.ensure", "access", "high", True, 6, "root", 60,
     obj({"account": A, "username": d("FtpUsername"), "root_path": d("RelPath"), "enabled": b(),
          "password": {"oneOf": [d("SecretPassword"), {"type": "null"}]}}),
     obj({"created": b(), "changed": b()})),
    ("ftp.user.remove", "access", "high", True, 6, "root", 60, obj({"account": A, "username": d("FtpUsername")}), obj({"removed": b()})),
    ("ssh.keys.apply", "access", "high", True, 6, "root", 60,
     obj({"account": A, "keys": arr(s(pattern="^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+( [^\\r\\n]{0,100})?$"), maxItems=50)}),
     obj({"count": i()})),
    # -- cron (D-74): systemd timer/service theo job, User + Slice của account
    ("cron.apply", "cron", "medium", True, 6, "root", 60,
     obj({"account": A, "entries": arr(obj({"uuid": d("Uuid"), "schedule": d("CronExpr"), "command": d("CronCommand"),
                                            "working_dir": d("RelPath"), "enabled": b(),
                                            "timeout_sec": i(minimum=60, maximum=86400)}), maxItems=200)}),
     obj({"count": i(), "active": i(), "removed": i()})),
    ("cron.inspect", "cron", "low", True, 6, "root", 30, obj({"account": A, "uuids": arr(d("Uuid"), maxItems=200)}),
     obj({"jobs": arr(obj({"uuid": d("Uuid"), "last_started_at": {"type": ["string", "null"]},
                           "last_finished_at": {"type": ["string", "null"]}, "exit_code": {"type": ["integer", "null"]},
                           "result": enum("success", "failed", "timeout", "never")}), maxItems=200)})),
    ("cron.run_once", "cron", "medium", True, 6, "account", 900,
     obj({"account": A, "uuid": d("Uuid"), "command": d("CronCommand"), "working_dir": d("RelPath"),
          "timeout_sec": i(minimum=1, maximum=900)}, required=["account", "uuid", "command", "working_dir"]),
     obj({"exit_code": i(), "output_tail": s(maxLength=8192), "timed_out": b(), "started_at": s(), "finished_at": s()})),
    # -- terminal USER (D-75): agent trả ticket một lần; gateway mở socket stream bằng ticket
    ("pty.open", "pty", "high", True, 6, "account", 15,
     obj({"account": A, "session_uuid": d("Uuid"), "cols": i(minimum=20, maximum=500), "rows": i(minimum=5, maximum=200),
          "idle_timeout_sec": i(minimum=60, maximum=3600)}),
     obj({"ticket": s(pattern="^[A-Za-z0-9_-]{32,64}$"), "expires_at": s(), "unix_user": d("Username")})),
    # -- backup (D-23: repo theo account)
    ("backup.run", "backup", "high", True, 8, "root", 7200,
     obj({"repo": d("BackupRepo"), "account": {"oneOf": [A, {"type": "null"}]}, "contents": arr(enum("files", "databases", "config"), minItems=1), "tags": arr(s(pattern="^[a-z0-9-]{1,32}$"))}),
     obj({"snapshot_id": s(pattern="^[0-9a-f]{8,64}$"), "size": d("Bytes")})),
    ("backup.restore", "backup", "high", True, 8, "root", 7200,
     obj({"repo": d("BackupRepo"), "snapshot_id": s(pattern="^[0-9a-f]{8,64}$"), "account": A, "mode": enum("new", "overwrite"),
          "items": arr(s(pattern="^(files:.+|database:[a-z][a-z0-9_]{0,63}|config)$"), minItems=1)}),
     obj({"restored_items": i()})),
    ("backup.check", "backup", "medium", True, 8, "root", 3600, obj({"repo": d("BackupRepo"), "read_data_subset": s(pattern="^[0-9]{1,2}%$")}), obj({"ok": b(), "errors": arr(s())})),
    ("backup.restore_test", "backup", "medium", True, 8, "root", 3600, obj({"repo": d("BackupRepo"), "snapshot_id": s(pattern="^[0-9a-f]{8,64}$"), "sample_files": i(minimum=1, maximum=1000)}),
     obj({"ok": b(), "verified_files": i()})),
    ("backup.forget", "backup", "critical", False, 8, "root", 3600,
     obj({"repo": d("BackupRepo"), "snapshot_ids": arr(s(pattern="^[0-9a-f]{8,64}$"), minItems=1)}), obj({"forgotten": i()})),
    # -- migrate (D-48)
    ("migrate.preflight", "migrate", "high", True, 9, "root", 600, obj({"account": A, "target_server_uuid": d("Uuid")}),
     obj({"ok": b(), "checks": arr(obj({"key": s(), "ok": b(), "detail": s()}))})),
    ("migrate.sync", "migrate", "high", True, 9, "root", 86400, obj({"account": A, "target_server_uuid": d("Uuid"), "pass": i(minimum=1, maximum=10)}), obj({"bytes": d("Bytes")})),
    ("migrate.verify", "migrate", "high", True, 9, "root", 3600, obj({"account": A, "target_server_uuid": d("Uuid")}),
     obj({"files_checked": i(), "mismatched": i(), "databases": {"type": "object", "additionalProperties": s()}})),
    ("migrate.cutover", "migrate", "critical", True, 9, "root", 1800, obj({"account": A, "target_server_uuid": d("Uuid")}), obj({"downtime_sec": i()})),
    ("migrate.rollback", "migrate", "high", True, 9, "root", 1800, obj({"account": A, "source_server_uuid": d("Uuid")}), obj({"rolled_back": b()})),
]

# Op của Phase 7–10: chỉ khai báo tên, rủi ro, mặc định (schema chi tiết viết ở Phase tương ứng).
DECLARED = [
    ("firewall.apply", "security", "critical", True, 7), ("firewall.confirm", "security", "high", True, 7),
    ("sshd.config.apply", "security", "critical", True, 7), ("fail2ban.apply", "security", "high", True, 7),
    ("waf.apply", "security", "high", True, 7), ("malware.scan", "security", "medium", True, 7),
    ("malware.restore", "security", "high", True, 7), ("fim.baseline", "security", "medium", True, 7),
    ("docker.container.control", "docker", "critical", False, 10),
    ("compose.validate", "docker", "medium", False, 10), ("compose.apply", "docker", "critical", False, 10),
    ("compose.up", "docker", "critical", False, 10), ("compose.down", "docker", "high", False, 10),
    ("compose.pull", "docker", "high", False, 10), ("wp.install", "wordpress", "high", True, 10),
    ("wp.update", "wordpress", "high", True, 10), ("wp.clone", "wordpress", "high", True, 10),
    ("wp.harden", "wordpress", "medium", True, 10),
    ("git.deploy", "git", "high", True, 10),
    ("git.rollback", "git", "high", True, 10),
]

# Bước do worker của panel thực hiện (gọi API bên ngoài), không phải op của agent.
PANEL_STEPS = ["dns.records.apply"]

ERRORS = [
    ("invalid_envelope", False, "Envelope sai schema"), ("unknown_op", False, "Op không có trong catalog"),
    ("op_disabled", False, "Op bị tắt bởi policy cục bộ (/etc/itso/agent-policy.yaml)"),
    ("invalid_params", False, "Tham số sai schema hoặc vi phạm ràng buộc"),
    ("path_outside_home", False, "Đường dẫn thoát khỏi home account (sau khi chuẩn hóa/symlink)"),
    ("reserved_name", False, "Tên bị cấm (username hệ thống, domain của panel...)"),
    ("not_found", False, "Đối tượng không tồn tại"), ("already_exists", False, "Đối tượng đã tồn tại với cấu hình khác"),
    ("precondition_failed", False, "Điều kiện trước không thỏa (sha256, trạng thái)"),
    ("quota_exceeded", False, "Vượt quota của account"), ("config_test_failed", False, "nginx -t / php-fpm -t / sshd -t thất bại, đã hoàn tác"),
    ("deadline_exceeded", True, "Hết deadline"), ("cancelled", False, "Đã hủy theo op.cancel"),
    ("busy", True, "Tài nguyên đang bị khóa bởi op khác (apt lock, ...)"), ("dependency_unavailable", True, "Dịch vụ phụ thuộc không phản hồi"),
    ("replay_rejected", False, "Nonce/timestamp không hợp lệ"), ("unauthorized_caller", False, "SO_PEERCRED/HMAC không hợp lệ"),
    ("internal", True, "Lỗi nội bộ agent"),
]


def write(name, data):
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if name.startswith("ops/"):
        text = text.replace('"defs.schema.json#', '"../defs.schema.json#')  # ref tương đối theo $id của file op
    (OUT / name).write_text(text, encoding="utf-8")


def main():
    (OUT / "ops").mkdir(parents=True, exist_ok=True)
    write("defs.schema.json", {"$schema": D2020, "$id": f"{BASE}/defs.schema.json", "title": "Kiểu dùng chung cho agent ops",
                               "$defs": DEFS})
    names = [o[0] for o in OPS]
    assert len(names) == len(set(names)), "op trùng"
    write("envelope.schema.json", {
        "$schema": D2020, "$id": f"{BASE}/envelope.schema.json", "title": "Request gửi tới agent",
        "type": "object", "additionalProperties": False,
        "required": ["v", "op", "op_id", "params", "deadline", "ts", "nonce", "requested_by"],
        "properties": {
            "v": {"const": 1},
            "op": {"type": "string", "enum": names + [x[0] for x in DECLARED]},
            "op_id": {"type": "string", "pattern": "^[0-9a-f-]{36}:[0-9]{1,4}:[0-9]{1,3}$",
                      "description": "job_uuid:seq:attempt_group — agent cache kết quả theo op_id (idempotent)."},
            "params": {"type": "object"},
            "deadline": {"type": "string", "format": "date-time"},
            "ts": {"type": "integer", "description": "Unix giây; lệch quá ±60 giây bị từ chối."},
            "nonce": {"type": "string", "pattern": "^[A-Za-z0-9_-]{16,64}$"},
            "dry_run": {"type": "boolean"},
            "requested_by": {"type": "object", "additionalProperties": False, "required": ["user_uuid", "role"],
                             "properties": {"user_uuid": {"type": ["string", "null"]}, "role": {"type": "string",
                                            "enum": ["SUPER_ADMIN", "ADMIN", "USER", "SYSTEM"]}},
                             "description": "Chỉ để audit; quyết định quyền nằm ở panel."},
        },
        "allOf": [{"if": {"properties": {"op": {"const": n}}, "required": ["op"]},
                   "then": {"properties": {"params": {"$ref": f"ops/{n}.schema.json#/$defs/params"}}}} for n in names],
    })
    write("result.schema.json", {
        "$schema": D2020, "$id": f"{BASE}/result.schema.json", "title": "Kết quả agent trả về",
        "type": "object", "additionalProperties": False, "required": ["v", "op_id", "ok", "duration_ms", "agent_version"],
        "properties": {
            "v": {"const": 1}, "op_id": {"type": "string"}, "ok": {"type": "boolean"},
            "data": {"type": ["object", "null"]},
            "error": {"type": ["object", "null"], "additionalProperties": False, "required": ["code", "message", "retryable"],
                      "properties": {"code": {"$ref": "errors.schema.json#/$defs/ErrorCode"}, "message": {"type": "string"},
                                     "retryable": {"type": "boolean"}, "details": {"type": "object"}}},
            "duration_ms": {"type": "integer", "minimum": 0}, "agent_version": {"type": "string"},
            "cached": {"type": "boolean", "description": "true nếu trả lại kết quả cũ theo op_id."},
        },
        "if": {"properties": {"ok": {"const": False}}}, "then": {"required": ["error"], "properties": {"error": {"type": "object"}}},
    })
    write("errors.schema.json", {"$schema": D2020, "$id": f"{BASE}/errors.schema.json", "title": "Mã lỗi agent",
                                 "$defs": {"ErrorCode": {"type": "string", "enum": [e[0] for e in ERRORS]}}})
    write("errors.json", {"version": 1, "errors": [{"code": c, "retryable": r, "description": t} for c, r, t in ERRORS]})
    catalog = []
    for name, dom, risk, on, phase, runs_as, timeout, params, result in OPS:
        write(f"ops/{name}.schema.json", {"$schema": D2020, "$id": f"{BASE}/ops/{name}.schema.json", "title": name,
                                          "$defs": {"params": params, "result": result}})
        catalog.append({"op": name, "domain": dom, "risk": risk, "default_enabled": on, "phase": phase,
                        "runs_as": runs_as, "timeout_sec": timeout, "schema": f"ops/{name}.schema.json", "status": "specified"})
    for name, dom, risk, on, phase in DECLARED:
        catalog.append({"op": name, "domain": dom, "risk": risk, "default_enabled": on, "phase": phase,
                        "runs_as": "root", "timeout_sec": None, "schema": None, "status": "declared"})
    write("catalog.json", {"version": 1, "ops": catalog, "panel_steps": PANEL_STEPS})
    print(f"Đã sinh agent-ops: {len(OPS)} op có schema, {len(DECLARED)} op khai báo")


if __name__ == "__main__":
    main()
