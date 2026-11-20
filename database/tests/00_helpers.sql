-- Hạ tầng test SQL: chạy MỘT lần sau khi áp schema. Không nằm trong schema sản phẩm.
CREATE SCHEMA IF NOT EXISTS itso_test;

-- Chạy câu lệnh, BẮT BUỘC lỗi với đúng SQLSTATE. In "PASS: <tên>" nếu đạt.
CREATE OR REPLACE FUNCTION itso_test.expect_error(p_name text, p_sql text, p_state text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = p_state THEN
      RAISE NOTICE 'PASS: %', p_name;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL: % — mong SQLSTATE %, nhận % (%)', p_name, p_state, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL: % — câu lệnh lẽ ra phải bị từ chối', p_name;
END $$;

-- Chạy câu lệnh, BẮT BUỘC thành công.
CREATE OR REPLACE FUNCTION itso_test.expect_ok(p_name text, p_sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RAISE NOTICE 'PASS: %', p_name;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FAIL: % — lỗi không mong muốn % (%)', p_name, SQLSTATE, SQLERRM;
END $$;

-- Khẳng định điều kiện boolean.
CREATE OR REPLACE FUNCTION itso_test.assert(p_name text, p_cond boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: % — điều kiện sai', p_name;
  END IF;
  RAISE NOTICE 'PASS: %', p_name;
END $$;

-- Dữ liệu nền dùng chung cho các test (gọi trong transaction của từng file rồi ROLLBACK).
CREATE OR REPLACE FUNCTION itso_test.seed() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO roles (id, key, realm, name) VALUES
    (1, 'SUPER_ADMIN', 'admin', 'Super Admin'), (2, 'ADMIN', 'admin', 'Admin'), (3, 'USER', 'portal', 'User');
  INSERT INTO users (id, realm, name, email, password_hash) VALUES
    (1, 'admin', 'Super Admin', 'root@itso.local', 'x'),
    (2, 'admin', 'Admin 2', 'admin2@itso.local', 'x'),
    (3, 'portal', 'Khách A', 'a@example.vn', 'x');
  INSERT INTO servers (id, name, hostname) VALUES (1, 'srv-01', 'srv-01.itso.local'), (2, 'srv-02', 'srv-02.itso.local');
  INSERT INTO hosting_packages (id, code, name) VALUES (1, 'basic', 'Basic');
  INSERT INTO hosting_package_versions (id, package_id, version, disk_mb, inode_limit, cpu_percent, ram_mb,
    tasks_max, php_workers_max, website_limit, alias_domain_limit, subdomain_limit, database_limit, db_user_limit,
    ftp_limit, cron_limit, backup_quota_mb)
    VALUES (1, 1, 1, 10240, 200000, 100, 1024, 256, 5, 3, 10, 10, 3, 3, 3, 5, 20480);
  INSERT INTO hosting_accounts (id, server_id, package_version_id, owner_user_id, username, uid, home_path)
    VALUES (1, 1, 1, 3, 'khacha', 20001, '/home/khacha');
  INSERT INTO websites (id, hosting_account_id, server_id, primary_domain) VALUES (1, 1, 1, 'a.example.vn');
END $$;
