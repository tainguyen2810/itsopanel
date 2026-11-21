#!/usr/bin/env python3
"""Hậu xử lý SQL do dbml2sql sinh ra.

- Bỏ dòng "Generated at" để kết quả xác định (CI so sánh diff được).
- Thêm PARTITION BY cho bảng phân vùng (DBML không biểu diễn được).
- Thêm extension cần thiết ở đầu file.
"""
import re
import sys
from pathlib import Path

PARTITIONED = {"audit_logs": "RANGE (\"at\")", "metric_samples": "RANGE (\"at\")", "waf_events": "RANGE (\"at\")"}

path = Path(sys.argv[1])
sql = path.read_text(encoding="utf-8")
sql = re.sub(r"^-- Generated at: .*\n", "", sql, flags=re.M)

for table, clause in PARTITIONED.items():
    pattern = re.compile(rf'(CREATE TABLE "{table}" \((?:.|\n)*?\n\));', re.M)
    if not pattern.search(sql):
        sys.exit(f"Không tìm thấy CREATE TABLE {table}")
    sql = pattern.sub(rf"\1 PARTITION BY {clause};", sql, count=1)

header = (
    "-- ITSO Panel schema — SINH TỰ ĐỘNG từ database/schema/itso.dbml (make db-schema). Không sửa tay.\n"
    "CREATE EXTENSION IF NOT EXISTS citext;\n"
    "CREATE EXTENSION IF NOT EXISTS pg_trgm;\n\n"
)
path.write_text(header + sql, encoding="utf-8")
print(f"Đã hậu xử lý {path}")
