-- Phase 11 (D-101…D-105): rollup metrics, rule/cảnh báo, uptime, kênh và nhật ký gửi thông báo.
BEGIN;
SELECT itso_test.seed();

-- metric_rollups: một dòng mỗi (server, account, metric, giờ), account NULL không trùng (NULLS NOT DISTINCT).
SELECT itso_test.expect_ok('Rollup giờ cho server',
  $$INSERT INTO metric_rollups (server_id, metric, bucket, min_value, avg_value, max_value, samples)
    VALUES (1, 'cpu_pct', '2026-11-22 10:00:00+00', 5, 20, 80, 60)$$);
SELECT itso_test.expect_error('Rollup trùng giờ (account NULL) bị từ chối',
  $$INSERT INTO metric_rollups (server_id, metric, bucket, min_value, avg_value, max_value, samples)
    VALUES (1, 'cpu_pct', '2026-11-22 10:00:00+00', 1, 2, 3, 1)$$, '23505');
SELECT itso_test.expect_ok('Cùng giờ nhưng theo account được phép',
  $$INSERT INTO metric_rollups (server_id, hosting_account_id, metric, bucket, min_value, avg_value, max_value, samples)
    VALUES (1, 1, 'cpu_pct', '2026-11-22 10:00:00+00', 1, 2, 3, 12)$$);
SELECT itso_test.expect_error('Bucket không tròn giờ bị từ chối',
  $$INSERT INTO metric_rollups (server_id, metric, bucket, min_value, avg_value, max_value, samples)
    VALUES (1, 'ram_pct', '2026-11-22 10:05:00+00', 1, 2, 3, 1)$$, '23514');
SELECT itso_test.expect_error('min > avg bị từ chối',
  $$INSERT INTO metric_rollups (server_id, metric, bucket, min_value, avg_value, max_value, samples)
    VALUES (1, 'ram_pct', '2026-11-22 11:00:00+00', 9, 2, 3, 1)$$, '23514');
SELECT itso_test.expect_ok('Mẫu metric theo account vào partition default',
  $$INSERT INTO metric_samples (server_id, hosting_account_id, metric, value, at) VALUES (1, 1, 'cpu_pct', 3.5, now())$$);

-- alert_rules + alerts
SELECT itso_test.expect_ok('Rule mặc định có default_key',
  $$INSERT INTO alert_rules (id, name, metric, operator, threshold, severity, channels, is_default, default_key)
    VALUES (1, 'Disk > 90%', 'disk_pct', 'gt', 90, 'high', '{in_app,email}', true, 'disk_high')$$);
SELECT itso_test.expect_error('Rule mặc định thiếu default_key bị từ chối',
  $$INSERT INTO alert_rules (name, metric, operator, threshold, is_default) VALUES ('X', 'cpu_pct', 'gt', 1, true)$$, '23514');
SELECT itso_test.expect_error('Kênh lạ bị từ chối',
  $$INSERT INTO alert_rules (name, metric, operator, threshold, channels) VALUES ('X', 'cpu_pct', 'gt', 1, '{sms}')$$, '23514');
SELECT itso_test.expect_error('Rule không có kênh bị từ chối',
  $$INSERT INTO alert_rules (name, metric, operator, threshold, channels) VALUES ('X', 'cpu_pct', 'gt', 1, '{}')$$, '23514');
SELECT itso_test.expect_error('Toán tử lạ bị từ chối',
  $$INSERT INTO alert_rules (name, metric, operator, threshold) VALUES ('X', 'cpu_pct', '>', 1)$$, '23514');
SELECT itso_test.expect_ok('Cảnh báo firing',
  $$INSERT INTO alerts (id, rule_id, server_id, fingerprint, state, severity, value, started_at, firing_at)
    VALUES (1, 1, 1, 'r1:server:1', 'firing', 'high', 93, now(), now())$$);
SELECT itso_test.expect_error('Cảnh báo mở thứ hai cùng fingerprint bị từ chối',
  $$INSERT INTO alerts (rule_id, server_id, fingerprint, state, severity, started_at)
    VALUES (1, 1, 'r1:server:1', 'pending', 'high', now())$$, '23505');
SELECT itso_test.expect_error('resolved mà không có resolved_at bị từ chối',
  $$UPDATE alerts SET state = 'resolved' WHERE id = 1$$, '23514');
SELECT itso_test.expect_ok('Resolve cảnh báo',
  $$UPDATE alerts SET state = 'resolved', resolved_at = now() WHERE id = 1$$);
SELECT itso_test.expect_ok('Đã resolve thì mở lại cùng fingerprint được',
  $$INSERT INTO alerts (rule_id, server_id, fingerprint, state, severity, started_at)
    VALUES (1, 1, 'r1:server:1', 'pending', 'high', now())$$);

-- uptime
SELECT itso_test.expect_ok('Uptime check đường dẫn hợp lệ',
  $$INSERT INTO uptime_checks (id, website_id, path, keyword) VALUES (1, 1, '/health?x=1', 'OK')$$);
SELECT itso_test.expect_error('Mỗi website một check',
  $$INSERT INTO uptime_checks (website_id, path) VALUES (1, '/')$$, '23505');
SELECT itso_test.expect_error('URL tuyệt đối bị từ chối',
  $$UPDATE uptime_checks SET path = 'https://evil.example/' WHERE id = 1$$, '23514');
SELECT itso_test.expect_error('Hai gạch đầu bị từ chối',
  $$UPDATE uptime_checks SET path = '//169.254.169.254/' WHERE id = 1$$, '23514');
SELECT itso_test.expect_error('Traversal bị từ chối',
  $$UPDATE uptime_checks SET path = '/a/../b' WHERE id = 1$$, '23514');
SELECT itso_test.expect_error('Chu kỳ dưới 60 giây bị từ chối',
  $$UPDATE uptime_checks SET interval_sec = 30 WHERE id = 1$$, '23514');
SELECT itso_test.assert('Tạo partition uptime theo ngày',
  itso_ensure_uptime_partition('2026-11-22') = 'uptime_results_20261122');
SELECT itso_test.expect_ok('Ghi kết quả uptime vào partition ngày',
  $$INSERT INTO uptime_results (check_id, ok, status, latency_ms, at) VALUES (1, true, 200, 120, '2026-11-22 08:00:00+00')$$);

-- uptime_rollups: một dòng mỗi check × giờ, ok ≤ total.
SELECT itso_test.expect_ok('Rollup uptime theo giờ',
  $$INSERT INTO uptime_rollups (check_id, bucket, ok_count, total, avg_latency_ms) VALUES (1, '2026-11-22 08:00:00+00', 59, 60, 120)$$);
SELECT itso_test.expect_error('Rollup uptime trùng giờ bị từ chối',
  $$INSERT INTO uptime_rollups (check_id, bucket, ok_count, total) VALUES (1, '2026-11-22 08:00:00+00', 1, 1)$$, '23505');
SELECT itso_test.expect_error('ok_count > total bị từ chối',
  $$INSERT INTO uptime_rollups (check_id, bucket, ok_count, total) VALUES (1, '2026-11-22 09:00:00+00', 5, 4)$$, '23514');
SELECT itso_test.expect_error('bucket không tròn giờ bị từ chối',
  $$INSERT INTO uptime_rollups (check_id, bucket, ok_count, total) VALUES (1, '2026-11-22 09:30:00+00', 1, 1)$$, '23514');

-- kênh + nhật ký gửi
SELECT itso_test.expect_error('Kênh telegram thiếu secret bị từ chối',
  $$INSERT INTO notification_channels (type, name, config) VALUES ('telegram', 'TG', '{"chat_id":"-100"}')$$, '23514');
SELECT itso_test.expect_ok('Kênh email không cần secret',
  $$INSERT INTO notification_channels (id, type, name, config) VALUES (1, 'email', 'Ops', '{"recipients":["ops@itso.vn"]}')$$);
SELECT itso_test.expect_error('Loại kênh lạ bị từ chối',
  $$INSERT INTO notification_channels (type, name, secret_encrypted) VALUES ('sms', 'SMS', 'x')$$, '23514');
SELECT itso_test.expect_ok('Lượt gửi queued',
  $$INSERT INTO notification_deliveries (channel_id, event_type, severity, title) VALUES (1, 'alert.firing', 'high', 'Disk')$$);
SELECT itso_test.expect_error('Trạng thái gửi lạ bị từ chối',
  $$INSERT INTO notification_deliveries (channel_id, event_type, severity, title, state) VALUES (1, 'x', 'high', 'x', 'lost')$$, '23514');
SELECT itso_test.expect_error('Lượt gửi không có kênh lẫn người nhận bị từ chối',
  $$INSERT INTO notification_deliveries (event_type, severity, title) VALUES ('x', 'high', 'x')$$, '23514');
SELECT itso_test.expect_ok('Email cá nhân: lượt gửi tới người nhận, không có kênh',
  $$INSERT INTO notification_deliveries (recipient_user_id, event_type, severity, title) VALUES (1, 'quota.warning', 'medium', 'Quota')$$);
SELECT itso_test.expect_error('Tùy chọn có kênh webhook (USER không có) bị từ chối',
  $$INSERT INTO notification_preferences (user_id, event_type, channels) VALUES (1, 'backup.failed', '{in_app,webhook}')$$, '23514');

ROLLBACK;
