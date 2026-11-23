#!/usr/bin/env python3
"""Sinh Laravel migration theo Phase từ đặc tả schema (itso.sql + extras.sql).

Đặc tả DBML là đích (database/docs/migration-plan.md). Mỗi Phase chỉ tạo bảng của mình: migration
của Phase N gồm mọi câu lệnh SQL mà **mọi bảng nó nhắc tới** thuộc các Phase ≤ N và chưa có trong
migration của Phase trước (vd. FK `hosting_accounts → backup_policies` chỉ thêm ở Phase 8).

    python3 database/tools/gen_migrations.py 3          # ghi apps/api/database/migrations/…phase_3…
    python3 database/tools/gen_migrations.py 3 --check  # kiểm file đã commit khớp đặc tả
    python3 database/tools/gen_migrations.py 3 --sql    # in SQL thô của Phase

File sinh ra chỉ gồm SQL lấy nguyên từ đặc tả; không sửa tay. Migration đã phát hành không sửa lại
(thay đổi schema sau này: sửa đặc tả + migration mới).
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "database" / "schema"
OUT_DIR = ROOT / "apps" / "api" / "database" / "migrations"

# Bảng theo Phase (database/docs/migration-plan.md §1).
PHASES: dict[int, list[str]] = {
    3: ["users", "roles", "permissions", "role_permissions", "user_roles", "user_scopes",
        "mfa_credentials", "sessions", "api_tokens", "login_attempts", "ip_allowlist",
        "impersonation_sessions", "tos_acceptances", "servers", "agents", "hosting_packages",
        "hosting_package_versions", "hosting_accounts", "account_lifecycle_events",
        "uid_allocations", "jobs", "job_steps", "job_logs", "audit_logs", "notifications", "settings"],
    4: ["server_services", "server_capacity", "software_catalog", "server_software",
        "account_usage_snapshots", "metric_samples"],
    5: ["websites", "domains", "website_settings", "acme_accounts", "certificates", "php_versions",
        "dns_providers", "dns_zones", "dns_records"],
    6: ["databases", "database_users", "database_grants", "sftp_accounts", "ssh_keys", "cron_jobs",
        "cron_runs", "upload_sessions", "file_operations", "terminal_sessions"],
    7: ["security_events", "firewall_rules", "malware_scans", "malware_findings", "quarantine_items",
        "fim_baselines", "firewall_applies", "security_settings", "waf_settings", "waf_events", "fim_changes",
        "terminal_recordings"],
    8: ["backup_destinations", "backup_repositories", "backup_policies", "backup_policy_destinations", "backup_jobs", "backup_snapshots",
        "backup_verifications", "restore_jobs", "purge_records"],
    9: ["agent_enrollment_tokens", "agent_certificates", "account_migrations"],
    10: ["docker_hosts", "registries", "compose_projects", "compose_revisions", "containers",
         "port_allocations", "image_rollbacks", "wordpress_sites", "wordpress_components", "wordpress_updates",
         "git_repositories", "git_deployments"],
    11: ["metric_rollups", "alert_rules", "alerts", "uptime_checks", "uptime_results", "uptime_rollups", "notification_channels",
         "notification_preferences", "notification_deliveries"],
    12: ["imports", "import_items", "cis_results"],
}
STAMP = "2026_11_20_{:06d}"


def split_sql(text: str) -> list[str]:
    """Tách câu lệnh theo `;` ngoài chuỗi, ngoài khối $$…$$ và bỏ chú thích `--`."""
    out, buf, i, n = [], [], 0, len(text)
    in_dollar = in_str = False
    while i < n:
        c = text[i]
        if not in_str and text.startswith("$$", i):
            in_dollar = not in_dollar
            buf.append("$$")
            i += 2
            continue
        if not in_dollar and c == "'":
            in_str = not in_str
        if not in_dollar and not in_str and text.startswith("--", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == ";" and not in_dollar and not in_str:
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt + ";")
            buf = []
        else:
            buf.append(c)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


def all_tables(stmts: list[str]) -> list[str]:
    names = [m.group(1) for s in stmts if (m := re.match(r'CREATE TABLE "?(\w+)"?\s*\(', s))]
    phased = {t for ts in PHASES.values() for t in ts}
    missing = set(names) - phased
    if missing:
        sys.exit(f"Bảng chưa gán Phase trong gen_migrations.py: {sorted(missing)}")
    return names


def phase_of() -> dict[str, int]:
    return {t: p for p, ts in PHASES.items() for t in ts}


# Vị trí cú pháp nơi tên bảng xuất hiện (tránh nhầm với tên cột trùng tên bảng, vd. php_versions).
REF_AT = r'(?:CREATE TABLE|ALTER TABLE|REFERENCES|PARTITION OF|COMMENT ON TABLE|COMMENT ON COLUMN|ON|FROM|JOIN|INTO|UPDATE)'


def refs(stmt: str, tables: list[str]) -> set[str]:
    found = {m.group(1) for m in re.finditer(rf'(?i)\b{REF_AT}\s+(?:IF NOT EXISTS\s+|ONLY\s+)?"?(\w+)"?', stmt)}
    return found & set(tables)


def select(phase: int) -> tuple[list[str], list[str]]:
    """Câu lệnh của Phase `phase` và danh sách bảng của Phase đó (theo thứ tự tạo)."""
    base = split_sql((SCHEMA / "itso.sql").read_text())
    extra = split_sql((SCHEMA / "extras.sql").read_text())
    tables = all_tables(base)
    ph = phase_of()
    funcs: dict[str, int] = {}  # hàm → Phase sớm nhất dùng được (theo bảng hàm nhắc tới)

    def level(stmt: str) -> int:
        r = refs(stmt, tables)
        lv = max((ph[t] for t in r), default=0)
        for f, fl in funcs.items():
            if re.search(rf"\b{f}\(", stmt) and not stmt.startswith(f"CREATE OR REPLACE FUNCTION {f}("):
                lv = max(lv, fl)
        return lv

    chosen = []
    for s in base + extra:
        if s.startswith("CREATE EXTENSION"):
            lv = min(PHASES)
        else:
            lv = level(s)
        # Thay đổi bảng của Phase trước (ALTER thêm cột/ràng buộc) đánh dấu `/* phase:N */` ở đầu câu lệnh
        # trong extras.sql, để không sửa migration đã phát hành.
        pm = re.match(r"/\* phase:(\d+) \*/", s)
        if pm:
            lv = max(lv, int(pm.group(1)))
        m = re.match(r"CREATE OR REPLACE FUNCTION (\w+)\(", s)
        if m:
            # Hàm dùng chung (vd. itso_reject_modify) không nhắc bảng nào → Phase đầu tiên.
            lv = max(lv, min(PHASES))
            funcs[m.group(1)] = lv
        if lv == phase:
            chosen.append(s)
    own = [t for t in tables if ph[t] == phase]
    return chosen, own


def render(phase: int) -> str:
    stmts, own = select(phase)
    # Nowdoc (<<<'SQL') giữ nguyên ký tự: KHÔNG nhân đôi dấu \ (trước 12.1 bị nhân đôi làm regex CHECK sai).
    sql = "\n\n".join(stmts)
    assert "\nSQL" not in sql, "SQL chứa dòng kết thúc nowdoc"
    drops = ", ".join(f'"{t}"' for t in reversed(own))
    return f"""<?php

// SINH TỰ ĐỘNG bởi database/tools/gen_migrations.py {phase} từ database/schema/itso.sql + extras.sql.
// Không sửa tay. Kiểm: python3 database/tools/gen_migrations.py {phase} --check (make db-migrations-check).

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Support\\Facades\\DB;

return new class extends Migration
{{
    /** Bảng Phase {phase}: {", ".join(own)}. */
    public function up(): void
    {{
        DB::unprepared(<<<'SQL'
{sql}
SQL);
    }}

    public function down(): void
    {{
        DB::unprepared(<<<'SQL'
DROP TABLE IF EXISTS {drops} CASCADE;
SQL);
    }}
}};
"""


def target(phase: int) -> Path:
    return OUT_DIR / f"{STAMP.format(phase)}_phase_{phase}_schema.php"


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    phase = int(args[0])
    if "--sql" in args:  # SQL thô của Phase (dùng cho scripts/db-migrations-check.sh)
        print("\n\n".join(select(phase)[0]))
        return 0
    text = render(phase)
    out = target(phase)
    if "--check" in args:
        if not out.exists() or out.read_text() != text:
            print(f"✗ {out.relative_to(ROOT)} lệch đặc tả — chạy: python3 database/tools/gen_migrations.py {phase}")
            return 1
        print(f"✓ {out.relative_to(ROOT)} khớp đặc tả")
        return 0
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    stmts, own = select(phase)
    print(f"Ghi {out.relative_to(ROOT)}: {len(own)} bảng, {len(stmts)} câu lệnh")
    return 0


if __name__ == "__main__":
    sys.exit(main())
