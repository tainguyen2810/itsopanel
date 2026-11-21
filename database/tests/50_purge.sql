-- Purge an toàn (D-46): giữ ≥30 ngày, legal hold, biên bản 2 bước, backup cuối đã xác minh.
BEGIN;
SELECT itso_test.seed();
DELETE FROM websites WHERE id = 1;

SELECT itso_test.expect_error('Purge account đang active bị từ chối',
  $$UPDATE hosting_accounts SET lifecycle_state = 'purged', terminated_at = now(), purge_after = now() WHERE id = 1$$,
  '23514');

UPDATE hosting_accounts SET lifecycle_state = 'terminated', terminated_at = now(),
  purge_after = now() + interval '30 days' WHERE id = 1;
SELECT itso_test.expect_error('Purge trước hạn purge_after bị từ chối',
  $$UPDATE hosting_accounts SET lifecycle_state = 'purged' WHERE id = 1$$, '23514');

UPDATE hosting_accounts SET terminated_at = now() - interval '31 days', purge_after = now() - interval '1 day' WHERE id = 1;
SELECT itso_test.expect_error('Purge khi chưa có biên bản bị từ chối',
  $$UPDATE hosting_accounts SET lifecycle_state = 'purged' WHERE id = 1$$, '23514');

INSERT INTO backup_destinations (id, name, type) VALUES (1, 'local', 'local');
INSERT INTO backup_repositories (id, destination_id, server_id, scope_type, hosting_account_id, path, password_encrypted)
  SELECT 1, 1, server_id, 'hosting_account', id, 'itso/' || gen_random_uuid() || '/acct-' || uuid, '\x00'
  FROM hosting_accounts WHERE id = 1;
INSERT INTO backup_snapshots (id, destination_id, repository_id, restic_snapshot_id, scope_type, hosting_account_id, taken_at, verified_at)
  VALUES (1, 1, 1, 'abc12345', 'hosting_account', 1, now(), now());
INSERT INTO purge_records (id, hosting_account_id, requested_by_user_id, confirmed_by_user_id,
  final_backup_snapshot_id, backup_verified_at, scheduled_for)
  VALUES (1, 1, 1, 1, 1, now(), now());
SELECT itso_test.expect_error('Người yêu cầu tự xác nhận (không đủ 2 bước) bị từ chối',
  $$UPDATE hosting_accounts SET lifecycle_state = 'purged' WHERE id = 1$$, '23514');

UPDATE purge_records SET confirmed_by_user_id = 2, backup_verified_at = NULL WHERE id = 1;
SELECT itso_test.expect_error('Backup cuối chưa xác minh bị từ chối',
  $$UPDATE hosting_accounts SET lifecycle_state = 'purged' WHERE id = 1$$, '23514');

UPDATE purge_records SET backup_verified_at = now() WHERE id = 1;
UPDATE hosting_accounts SET legal_hold = true WHERE id = 1;
SELECT itso_test.expect_error('Account đang legal hold bị từ chối',
  $$UPDATE hosting_accounts SET lifecycle_state = 'purged' WHERE id = 1$$, '23514');

UPDATE hosting_accounts SET legal_hold = false WHERE id = 1;
SELECT itso_test.expect_ok('Purge hợp lệ (đủ điều kiện) được chấp nhận',
  $$UPDATE hosting_accounts SET lifecycle_state = 'purged' WHERE id = 1$$);
ROLLBACK;
