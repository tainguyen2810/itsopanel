-- Audit log append-only + chuỗi hash; partition.
BEGIN;
SELECT itso_test.seed();

INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id) VALUES (1, 'hosting.create', 'hosting_account', 1);
INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, at)
  VALUES (1, 'hosting.suspend', 'hosting_account', 1, now() + interval '1 second');

SELECT itso_test.assert('Bản ghi audit đầu có hash, prev_hash rỗng',
  (SELECT hash IS NOT NULL AND prev_hash IS NULL FROM audit_logs WHERE action = 'hosting.create'));
SELECT itso_test.assert('Bản ghi audit sau nối hash của bản ghi trước',
  (SELECT b.prev_hash = a.hash FROM audit_logs a, audit_logs b
   WHERE a.action = 'hosting.create' AND b.action = 'hosting.suspend'));
SELECT itso_test.expect_error('UPDATE audit_logs bị từ chối',
  $$UPDATE audit_logs SET action = 'x'$$, '42501');
SELECT itso_test.expect_error('DELETE audit_logs bị từ chối',
  $$DELETE FROM audit_logs$$, '42501');
INSERT INTO account_lifecycle_events (hosting_account_id, from_state, to_state, actor_user_id)
  VALUES (1, 'pending', 'active', 1);
SELECT itso_test.expect_error('UPDATE account_lifecycle_events bị từ chối',
  $$UPDATE account_lifecycle_events SET to_state = 'x'$$, '42501');
SELECT itso_test.assert('Tạo partition audit theo tháng',
  itso_ensure_audit_partition('2030-01-15') = 'audit_logs_203001');
INSERT INTO audit_logs (action, at) VALUES ('partition.check', '2030-01-20 10:00+07');
SELECT itso_test.assert('Bản ghi tháng 01/2030 nằm đúng partition',
  (SELECT tableoid::regclass::text FROM audit_logs WHERE action = 'partition.check') = 'audit_logs_203001');
ROLLBACK;
