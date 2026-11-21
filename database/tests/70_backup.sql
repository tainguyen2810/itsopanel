-- Backup & Restore (Phase 8, D-82…D-87): repo theo account × đích, phạm vi policy, snapshot/kiểm chứng hợp lệ.
BEGIN;
SELECT itso_test.seed();

INSERT INTO backup_destinations (id, name, type) VALUES (10, 'local', 'local'), (11, 's3', 's3');
SELECT itso_test.expect_error('Loại đích lạ bị từ chối',
  $$INSERT INTO backup_destinations (name, type) VALUES ('ftp', 'ftp')$$, '23514');

SELECT itso_test.expect_ok('Repo theo account trên đích local được chấp nhận',
  $$INSERT INTO backup_repositories (id, destination_id, server_id, scope_type, hosting_account_id, path, password_encrypted)
    SELECT 10, 10, server_id, 'hosting_account', id, 'itso/' || gen_random_uuid() || '/acct-' || uuid, '\x01'
    FROM hosting_accounts WHERE id = 1$$);
SELECT itso_test.expect_error('Repo thứ hai cho cùng account × đích × máy chủ bị từ chối',
  $$INSERT INTO backup_repositories (destination_id, server_id, scope_type, hosting_account_id, path, password_encrypted)
    SELECT 10, server_id, 'hosting_account', id, 'itso/' || gen_random_uuid() || '/acct-' || uuid, '\x01'
    FROM hosting_accounts WHERE id = 1$$, '23505');
SELECT itso_test.expect_ok('Cùng account trên đích khác được chấp nhận',
  $$INSERT INTO backup_repositories (destination_id, server_id, scope_type, hosting_account_id, path, password_encrypted)
    SELECT 11, server_id, 'hosting_account', id, 'itso/' || gen_random_uuid() || '/acct-' || uuid, '\x01'
    FROM hosting_accounts WHERE id = 1$$);
SELECT itso_test.expect_error('Repo account thiếu hosting_account_id bị từ chối',
  $$INSERT INTO backup_repositories (destination_id, server_id, scope_type, path, password_encrypted)
    VALUES (11, 1, 'hosting_account', 'itso/' || gen_random_uuid() || '/server', '\x01')$$, '23514');
SELECT itso_test.expect_error('Đường dẫn repo tự do (thoát khỏi itso/<server>/...) bị từ chối',
  $$INSERT INTO backup_repositories (destination_id, server_id, scope_type, path, password_encrypted)
    VALUES (11, 1, 'server', '../etc', '\x01')$$, '23514');
SELECT itso_test.expect_ok('Repo server được chấp nhận',
  $$INSERT INTO backup_repositories (destination_id, server_id, scope_type, path, password_encrypted)
    VALUES (10, 1, 'server', 'itso/' || gen_random_uuid() || '/server', '\x01')$$);
SELECT itso_test.expect_error('Hai repo server cùng đích × máy chủ bị từ chối',
  $$INSERT INTO backup_repositories (destination_id, server_id, scope_type, path, password_encrypted)
    VALUES (10, 1, 'server', 'itso/' || gen_random_uuid() || '/server', '\x01')$$, '23505');
SELECT itso_test.expect_error('quota_state lạ bị từ chối',
  $$UPDATE backup_repositories SET quota_state = 'full' WHERE id = 10$$, '23514');

SELECT itso_test.expect_error('Policy phạm vi lạ bị từ chối',
  $$INSERT INTO backup_policies (name, scope_type, schedule) VALUES ('x', 'compose', '0 2 * * *')$$, '23514');
SELECT itso_test.expect_error('Policy nội dung lạ bị từ chối',
  $$INSERT INTO backup_policies (name, scope_type, schedule, contents) VALUES ('x', 'all_accounts', '0 2 * * *', '{files,mail}')$$, '23514');
SELECT itso_test.expect_error('Policy quá 50 mẫu loại trừ bị từ chối',
  $$INSERT INTO backup_policies (name, scope_type, schedule, excludes)
    VALUES ('x', 'all_accounts', '0 2 * * *', (SELECT array_agg('tmp' || g) FROM generate_series(1, 51) g))$$, '23514');
SELECT itso_test.expect_ok('Policy ghi vào hai đích được chấp nhận',
  $$INSERT INTO backup_policies (id, name, scope_type, schedule) VALUES (10, 'hằng ngày', 'all_accounts', '0 2 * * *');
    INSERT INTO backup_policy_destinations (policy_id, destination_id) VALUES (10, 10), (10, 11)$$);

SELECT itso_test.expect_error('Snapshot id không phải hex bị từ chối',
  $$INSERT INTO backup_snapshots (destination_id, repository_id, restic_snapshot_id, scope_type, taken_at)
    VALUES (10, 10, 'latest; rm', 'hosting_account', now())$$, '23514');
SELECT itso_test.expect_ok('Snapshot hợp lệ được chấp nhận',
  $$INSERT INTO backup_snapshots (id, destination_id, repository_id, restic_snapshot_id, scope_type, hosting_account_id, taken_at)
    VALUES (10, 10, 10, '4f2a9c1e', 'hosting_account', 1, now())$$);
SELECT itso_test.expect_error('Trùng snapshot trong cùng repo bị từ chối',
  $$INSERT INTO backup_snapshots (destination_id, repository_id, restic_snapshot_id, scope_type, taken_at)
    VALUES (10, 10, '4f2a9c1e', 'hosting_account', now())$$, '23505');
SELECT itso_test.expect_error('Loại kiểm chứng lạ bị từ chối',
  $$INSERT INTO backup_verifications (destination_id, kind) VALUES (10, 'scan')$$, '23514');
SELECT itso_test.expect_ok('Kiểm chứng restore_test được chấp nhận',
  $$INSERT INTO backup_verifications (destination_id, repository_id, snapshot_id, kind, state) VALUES (10, 10, 10, 'restore_test', 'succeeded')$$);

ROLLBACK;
