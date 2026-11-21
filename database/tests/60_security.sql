-- Security Center (Phase 7, D-76…D-81): safe-apply một lần chờ, ràng buộc WAF/FIM, partition sự kiện WAF.
BEGIN;
SELECT itso_test.seed();

INSERT INTO firewall_applies (server_id, target, user_id, client_ip, status, deadline_at)
  VALUES (1, 'firewall', 1, '10.10.5.20', 'pending_confirm', now() + interval '2 minutes');
SELECT itso_test.expect_error('Hai lần safe-apply tường lửa cùng chờ xác nhận trên một máy chủ bị từ chối',
  $$INSERT INTO firewall_applies (server_id, target, user_id, client_ip, status, deadline_at)
    VALUES (1, 'firewall', 1, '10.10.5.20', 'pending_confirm', now() + interval '2 minutes')$$, '23505');
SELECT itso_test.expect_ok('SSH chờ xác nhận song song với tường lửa được chấp nhận',
  $$INSERT INTO firewall_applies (server_id, target, user_id, client_ip, status, deadline_at)
    VALUES (1, 'sshd', 1, '10.10.5.20', 'pending_confirm', now() + interval '2 minutes')$$);
SELECT itso_test.expect_error('Loại safe-apply lạ bị từ chối',
  $$INSERT INTO firewall_applies (server_id, target, client_ip, deadline_at) VALUES (1, 'nginx', '10.0.0.1', now())$$, '23514');
SELECT itso_test.expect_ok('Sau khi xác nhận có thể áp dụng lần mới',
  $$UPDATE firewall_applies SET status = 'confirmed', confirmed_at = now() WHERE target = 'firewall';
    INSERT INTO firewall_applies (server_id, target, client_ip, deadline_at) VALUES (1, 'firewall', '10.0.0.1', now())$$);

SELECT itso_test.expect_error('WAF mode ngoài DetectionOnly|On|Off bị từ chối',
  $$INSERT INTO waf_settings (website_id, mode) VALUES (1, 'Block')$$, '23514');
SELECT itso_test.expect_error('Paranoia level 5 bị từ chối',
  $$INSERT INTO waf_settings (website_id, paranoia_level) VALUES (1, 5)$$, '23514');
SELECT itso_test.expect_ok('WAF mặc định DetectionOnly',
  $$INSERT INTO waf_settings (website_id, rule_exclusions) VALUES (1, '{942100}')$$);
SELECT itso_test.assert('WAF mới ở chế độ DetectionOnly',
  (SELECT mode = 'DetectionOnly' FROM waf_settings WHERE website_id = 1));

SELECT itso_test.expect_ok('Sự kiện WAF vào partition mặc định',
  $$INSERT INTO waf_events (at, website_id, rule_id, severity, action, client_ip)
    VALUES (now(), 1, 942100, 'critical', 'blocked', '198.51.100.23')$$);
SELECT itso_test.assert('Có partition waf_events theo tháng',
  itso_ensure_waf_partition('2026-12-01') = 'waf_events_202612');
SELECT itso_test.expect_error('Hành động WAF lạ bị từ chối',
  $$INSERT INTO waf_events (at, website_id, rule_id, severity, action) VALUES (now(), 1, 1, 'low', 'allow')$$, '23514');

SELECT itso_test.expect_error('Loại thay đổi FIM lạ bị từ chối',
  $$INSERT INTO fim_changes (server_id, path, change) VALUES (1, '/etc/passwd', 'renamed')$$, '23514');

SELECT itso_test.expect_ok('Rule tường lửa mặc định: vào, tcp, bật, có uuid',
  $$INSERT INTO firewall_rules (server_id, action, port_range, source_cidr) VALUES (1, 'accept', '80,443', '0.0.0.0/0')$$);
SELECT itso_test.assert('Rule mới có direction in, enabled, uuid',
  (SELECT direction = 'in' AND enabled AND uuid IS NOT NULL FROM firewall_rules WHERE port_range = '80,443'));
SELECT itso_test.expect_error('Hướng rule lạ bị từ chối',
  $$INSERT INTO firewall_rules (server_id, action, direction) VALUES (1, 'drop', 'forward')$$, '23514');
SELECT itso_test.expect_error('Giao thức rule lạ bị từ chối',
  $$INSERT INTO firewall_rules (server_id, action, protocol) VALUES (1, 'drop', 'sctp')$$, '23514');
SELECT itso_test.expect_error('Priority ngoài 1–9999 bị từ chối',
  $$INSERT INTO firewall_rules (server_id, action, priority) VALUES (1, 'drop', 0)$$, '23514');
SELECT itso_test.expect_error('Finding mã độc với sha256 sai định dạng bị từ chối',
  $$INSERT INTO malware_scans (server_id, status) VALUES (1, 'queued');
    INSERT INTO malware_findings (scan_id, path, signature, engine, sha256)
    VALUES ((SELECT max(id) FROM malware_scans), 'a.php', 'x', 'clamav', 'XYZ')$$, '23514');
SELECT itso_test.expect_error('Engine quét lạ bị từ chối',
  $$INSERT INTO malware_scans (server_id, status) VALUES (1, 'queued');
    INSERT INTO malware_findings (scan_id, path, signature, engine, sha256)
    VALUES ((SELECT max(id) FROM malware_scans), 'a.php', 'x', 'maldet', repeat('a', 64))$$, '23514');
ROLLBACK;
