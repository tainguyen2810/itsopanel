-- Realm (D-40): bất biến, vai trò phải khớp realm, chủ hosting phải là portal.
BEGIN;
SELECT itso_test.seed();

SELECT itso_test.expect_error('Đổi realm của user bị từ chối',
  $$UPDATE users SET realm = 'portal' WHERE id = 1$$, '23514');
SELECT itso_test.expect_ok('Đổi tên user (không đổi realm) vẫn được',
  $$UPDATE users SET name = 'Super Admin mới' WHERE id = 1$$);
SELECT itso_test.expect_error('Gán vai trò USER cho user realm admin bị từ chối',
  $$INSERT INTO user_roles (user_id, role_id) VALUES (1, 3)$$, '23514');
SELECT itso_test.expect_error('Gán vai trò SUPER_ADMIN cho user realm portal bị từ chối',
  $$INSERT INTO user_roles (user_id, role_id) VALUES (3, 1)$$, '23514');
SELECT itso_test.expect_ok('Gán vai trò khớp realm được chấp nhận',
  $$INSERT INTO user_roles (user_id, role_id) VALUES (1, 1), (3, 3)$$);
SELECT itso_test.expect_error('Mỗi user chỉ một vai trò',
  $$INSERT INTO user_roles (user_id, role_id) VALUES (1, 2)$$, '23505');
SELECT itso_test.expect_error('Role USER với realm admin bị từ chối',
  $$INSERT INTO roles (key, realm, name) VALUES ('USER2', 'admin', 'x')$$, '23514');
SELECT itso_test.expect_error('Realm lạ bị từ chối',
  $$INSERT INTO users (realm, name, email, password_hash) VALUES ('reseller', 'x', 'x@x.vn', 'x')$$, '23514');
SELECT itso_test.expect_error('Email trùng (không phân biệt hoa thường) bị từ chối',
  $$INSERT INTO users (realm, name, email, password_hash) VALUES ('portal', 'x', 'A@Example.VN', 'x')$$, '23505');
SELECT itso_test.expect_error('Chủ hosting account là user admin bị từ chối',
  $$INSERT INTO hosting_accounts (server_id, package_version_id, owner_user_id, username, uid, home_path)
    VALUES (1, 1, 1, 'adminacc', 20002, '/home/adminacc')$$, '23514');
ROLLBACK;
