# ADR 0018: Database hosting (MariaDB + PostgreSQL), danh tính chủ theo account

- **Trạng thái:** Accepted (2026-11-21, cùng Phase 6)
- **Ngày:** 2026-11-21
- **Quyết định liên quan:** D-71, D-09, D-02, D-63, D-69

## Bối cảnh

Account hosting cần database cho website. Server chạy chung một MariaDB và một PostgreSQL cho mọi account, nên ranh giới giữa các account nằm ở quyền SQL. Ba rủi ro chính: (1) chèn SQL qua tên DB/user/mật khẩu do người dùng nhập; (2) mật khẩu lộ qua argv (`ps`), log job hoặc audit; (3) import dump bằng quyền quản trị: file dump là dữ liệu của khách, có thể chứa `USE other_db; DROP …`, `GRANT …`, `CREATE USER …`.

## Quyết định

1. **Engine:** MariaDB 10.11 từ kho Ubuntu (recipe `mariadb`, D-09) và PostgreSQL 16 cluster `main` (recipe `postgresql`). Panel dùng cluster riêng (D-02), không chia sẻ với khách. MySQL 8: DEFERRED (cùng op `db.mysql.*`, khác recipe; không cài song song với MariaDB).
2. **Agent quản trị bằng xác thực socket:** `mariadb` chạy dưới root (plugin `unix_socket` của `root@localhost`), `psql` chạy dưới user `postgres` (peer). Không có mật khẩu quản trị nào trên máy hay trong panel. Agent gọi qua Runner (D-63): argv cố định (`mariadb --batch --skip-column-names`, `psql -X -v ON_ERROR_STOP=1 -At`), **câu SQL gửi qua stdin**.
3. **Định danh:** tên DB/user theo `DbName` (`^[a-z][a-z0-9_]{0,63}$`, PostgreSQL ≤ 63) và **bắt buộc tiền tố `<username>_`**; agent kiểm lại tiền tố theo `account.username` trong params, từ chối tên hệ thống (`mysql`, `information_schema`, `performance_schema`, `sys`, `postgres`, `template0/1`). Định danh luôn được quote (`` `x` `` / `"x"`) dù regex đã chặn ký tự lạ.
4. **Mật khẩu:** kiểu `SecretPassword` (12–128 ký tự, không nháy, gạch chéo ngược, khoảng trắng, xuống dòng). Panel sinh hoặc nhận mật khẩu, lưu mã hóa (`database_users.password_encrypted`), job chỉ mang tham chiếu `{"$secret": "db_user:<uuid>"}`; JobRunner thay ngay trước khi gọi agent và không ghi vào `job_steps`/audit (cơ chế D-69). Mật khẩu chỉ trả cho người dùng **một lần** (`secret` trong `JobAccepted` hoặc `:rotate-password`).
5. **Danh tính chủ của account:** op `db.*.owner_ensure` tạo
   - MariaDB: `'<username>'@'localhost' IDENTIFIED VIA unix_socket`, `GRANT ALL ON <mẫu tiền tố "username\_%">.* TO …` (mọi DB theo tiền tố), `MAX_USER_CONNECTIONS 20`.
   - PostgreSQL: role `<username>` `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`, xác thực `peer` qua socket local; mỗi DB của account `OWNER <username>`, `REVOKE ALL ON DATABASE … FROM PUBLIC`.
6. **Dump/import chạy dưới uid account** (`runs_as: account`): agent chạy `mariadb-dump`/`mariadb` hoặc `pg_dump`/`psql` với Credential uid/gid của account, kết nối bằng danh tính chủ (socket/peer), nên SQL trong file chỉ có quyền của account. File đọc/ghi qua helper File Manager (ADR 0019): agent nối stdout của `*-dump` vào fd do helper mở trong home (dưới uid account), và stdin của client vào fd file nguồn. Root không mở file trong home.
7. **User DB thường** (`db.*.user_ensure`): `host` `localhost` hoặc `%` (chỉ khi Admin bật), `max_connections`, quyền theo DB (`grant`, danh sách rỗng = thu hồi hết). PostgreSQL: quyền `CONNECT` + `USAGE, CREATE ON SCHEMA public` + quyền bảng mặc định theo danh sách.
8. **Tạm khóa account:** `db.*.lock` → MariaDB `ALTER USER … ACCOUNT LOCK` cho chủ và mọi user tiền tố, PostgreSQL `ALTER ROLE … NOLOGIN`. Mở khóa làm ngược lại.
9. **Kích thước:** `db.*.inspect` đọc kích thước (information_schema / `pg_database_size`) cho `databases.size_mb`.

## Hệ quả

- Không có đường leo thang qua import; một account không đọc được DB của account khác (G1).
- SQL sinh ra là chuỗi cố định + định danh đã validate + mật khẩu đã giới hạn bộ ký tự; test golden so khớp từng câu, test vector độc (định danh, mật khẩu).
- Không cài MariaDB/PostgreSQL hosting trong container cloud: chạy thật trên VM (`tests/vm/phase6.sh`).
