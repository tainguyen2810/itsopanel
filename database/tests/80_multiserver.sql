-- Multi-server (Phase 9, D-88…D-93): vai trò node, kênh agent, chứng chỉ, token join, job chờ node, chuyển account.
BEGIN;
SELECT itso_test.seed();

SELECT itso_test.assert('Server mặc định là all_in_one',
  (SELECT node_role FROM servers WHERE id = 1) = 'all_in_one');
SELECT itso_test.expect_error('Vai trò node lạ bị từ chối',
  $$UPDATE servers SET node_role = 'worker' WHERE id = 2$$, '23514');
SELECT itso_test.expect_ok('Server 2 là node',
  $$UPDATE servers SET node_role = 'node' WHERE id = 2$$);

INSERT INTO agents (server_id, transport) VALUES (1, 'local'), (2, 'mtls');
SELECT itso_test.assert('Agent mới ở trạng thái pending',
  (SELECT connection FROM agents WHERE server_id = 2) = 'pending');
SELECT itso_test.expect_error('Trạng thái kết nối lạ bị từ chối',
  $$UPDATE agents SET connection = 'sleeping' WHERE server_id = 2$$, '23514');
SELECT itso_test.expect_ok('Thu hồi node: connection = revoked',
  $$UPDATE agents SET connection = 'revoked', revoked_at = now() WHERE server_id = 2$$);

SELECT itso_test.expect_ok('Chứng chỉ node hợp lệ',
  $$INSERT INTO agent_certificates (server_id, serial, fingerprint_sha256, not_before, not_after, issued_reason)
    VALUES (2, '01ab', repeat('a', 64), now(), now() + interval '30 days', 'enroll')$$);
SELECT itso_test.expect_error('Fingerprint trùng bị từ chối',
  $$INSERT INTO agent_certificates (server_id, serial, fingerprint_sha256, not_before, not_after, issued_reason)
    VALUES (2, '01ac', repeat('a', 64), now(), now() + interval '30 days', 'rotate')$$, '23505');
SELECT itso_test.expect_error('Fingerprint sai định dạng bị từ chối',
  $$INSERT INTO agent_certificates (server_id, serial, fingerprint_sha256, not_before, not_after, issued_reason)
    VALUES (2, '01ad', 'AB:CD', now(), now() + interval '30 days', 'rotate')$$, '23514');
SELECT itso_test.expect_error('Lý do cấp lạ bị từ chối',
  $$INSERT INTO agent_certificates (server_id, serial, fingerprint_sha256, not_before, not_after, issued_reason)
    VALUES (2, '01ae', repeat('b', 64), now(), now() + interval '30 days', 'manual')$$, '23514');

SELECT itso_test.expect_ok('Token join lưu sha256',
  $$INSERT INTO agent_enrollment_tokens (token_hash, server_name, created_by_user_id, expires_at)
    VALUES (repeat('c', 64), 'srv-03', 1, now() + interval '1 hour')$$);
SELECT itso_test.expect_error('Token lưu dạng rõ bị từ chối',
  $$INSERT INTO agent_enrollment_tokens (token_hash, server_name, created_by_user_id, expires_at)
    VALUES ('itso_enr_plaintext', 'srv-04', 1, now() + interval '1 hour')$$, '23514');

SELECT itso_test.expect_ok('Job chờ node (waiting_agent)',
  $$INSERT INTO jobs (type, server_id, state, agent_deadline_at) VALUES ('service.restart', 2, 'waiting_agent', now() + interval '15 minutes')$$);
SELECT itso_test.expect_error('Trạng thái job lạ vẫn bị từ chối',
  $$INSERT INTO jobs (type, server_id, state) VALUES ('service.restart', 2, 'paused')$$, '23514');

SELECT itso_test.expect_ok('Lần chuyển account sang server khác',
  $$INSERT INTO account_migrations (id, hosting_account_id, source_server_id, target_server_id, requested_by_user_id)
    VALUES (1, 1, 1, 2, 1)$$);
SELECT itso_test.expect_error('Lần chuyển thứ hai khi lần trước chưa xong bị từ chối',
  $$INSERT INTO account_migrations (hosting_account_id, source_server_id, target_server_id, requested_by_user_id)
    VALUES (1, 1, 2, 1)$$, '23505');
SELECT itso_test.expect_ok('Giữ nguồn (holding) là trạng thái hợp lệ',
  $$UPDATE account_migrations SET state = 'holding', cutover_at = now(), cleanup_after = now() + interval '7 days' WHERE id = 1$$);
SELECT itso_test.expect_error('Giữ nguồn quá 30 ngày bị từ chối',
  $$UPDATE account_migrations SET keep_source_days = 60 WHERE id = 1$$, '23514');
SELECT itso_test.expect_ok('Xong lần chuyển thì được tạo lần mới',
  $$UPDATE account_migrations SET state = 'completed' WHERE id = 1;
    INSERT INTO account_migrations (hosting_account_id, source_server_id, target_server_id, requested_by_user_id)
    VALUES (1, 2, 1, 1)$$);
SELECT itso_test.expect_error('Chuyển sang chính server nguồn bị từ chối',
  $$INSERT INTO account_migrations (hosting_account_id, source_server_id, target_server_id, requested_by_user_id, state)
    VALUES (1, 1, 1, 1, 'completed')$$, '23514');

ROLLBACK;
