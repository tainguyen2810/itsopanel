# database/schema

| File | Vai trò | Sửa thế nào |
|---|---|---|
| `itso.dbml` | Đặc tả schema (78 bảng, 8 nhóm) | **Sinh** từ `database/tools/gen_dbml.py` |
| `itso.sql` | SQL PostgreSQL 16 sinh từ DBML (`@dbml/cli` 3.9.0) + hậu xử lý partition/extension | **Sinh**, không sửa tay |
| `extras.sql` | CHECK, partial unique, trigger (realm, purge guard, append-only, hash chain), partition mặc định | Viết tay |

Quy trình: sửa `gen_dbml.py` (hoặc `extras.sql`) → `make db-schema` → `make db-verify` → `make db-erd`. Kết quả sinh ra xác định (không có dấu thời gian), commit cùng thay đổi.

Test SQL ở `database/tests/` (`00_helpers.sql` dựng hàm `itso_test.*`, mỗi file test chạy trong transaction rồi ROLLBACK).
