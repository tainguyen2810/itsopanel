-- Hosting account: UID, username, RESTRICT, package bất biến, migration.
BEGIN;
SELECT itso_test.seed();

SELECT itso_test.expect_error('UID trùng trên cùng server bị từ chối',
  $$INSERT INTO hosting_accounts (server_id, package_version_id, owner_user_id, username, uid, home_path)
    VALUES (1, 1, 3, 'khachb', 20001, '/home/khachb')$$, '23505');
SELECT itso_test.expect_ok('Cùng UID ở server khác được chấp nhận',
  $$INSERT INTO hosting_accounts (id, server_id, package_version_id, owner_user_id, username, uid, home_path)
    VALUES (2, 2, 1, 3, 'khacha', 20001, '/home/khacha')$$);
SELECT itso_test.expect_error('UID ngoài dải 20000–59999 bị từ chối',
  $$INSERT INTO hosting_accounts (server_id, package_version_id, owner_user_id, username, uid, home_path)
    VALUES (1, 1, 3, 'khachc', 1000, '/home/khachc')$$, '23514');
SELECT itso_test.expect_error('Username sai định dạng bị từ chối',
  $$INSERT INTO hosting_accounts (server_id, package_version_id, owner_user_id, username, uid, home_path)
    VALUES (1, 1, 3, 'Root-User', 20010, '/home/x')$$, '23514');
SELECT itso_test.expect_error('Xóa hosting account còn website bị từ chối (RESTRICT)',
  $$DELETE FROM hosting_accounts WHERE id = 1$$, '23503');
SELECT itso_test.expect_error('Xóa server còn hosting account bị từ chối',
  $$DELETE FROM servers WHERE id = 1$$, '23503');
SELECT itso_test.expect_error('Sửa package version bị từ chối (bất biến, D-43)',
  $$UPDATE hosting_package_versions SET disk_mb = 1 WHERE id = 1$$, '42501');
SELECT itso_test.expect_error('Xóa package version bị từ chối',
  $$DELETE FROM hosting_package_versions WHERE id = 1$$, '42501');
SELECT itso_test.expect_error('Package giữ dữ liệu dưới 30 ngày bị từ chối (D-46)',
  $$INSERT INTO hosting_package_versions (package_id, version, disk_mb, inode_limit, cpu_percent, ram_mb,
    tasks_max, php_workers_max, website_limit, alias_domain_limit, subdomain_limit, database_limit, db_user_limit,
    ftp_limit, cron_limit, backup_quota_mb, retention_days_after_terminate)
    VALUES (1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 7)$$, '23514');
SELECT itso_test.expect_error('Terminated mà thiếu purge_after bị từ chối',
  $$UPDATE hosting_accounts SET lifecycle_state = 'terminated', terminated_at = now() WHERE id = 1$$, '23514');
SELECT itso_test.expect_error('Migration cùng server nguồn và đích bị từ chối',
  $$INSERT INTO account_migrations (hosting_account_id, source_server_id, target_server_id, requested_by_user_id)
    VALUES (1, 1, 1, 1)$$, '23514');
ROLLBACK;
