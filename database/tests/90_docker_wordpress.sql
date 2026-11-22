-- Phase 10 (D-94…D-100): Docker host, compose + revision, cấp cổng, rollback image, WordPress Toolkit, Software Manager.
BEGIN;
SELECT itso_test.seed();

INSERT INTO docker_hosts (server_id) VALUES (1);
SELECT itso_test.assert('Docker host mặc định chưa cài, dải 20000–29999',
  (SELECT state = 'not_installed' AND port_range_from = 20000 AND port_range_to = 29999 FROM docker_hosts WHERE server_id = 1));
SELECT itso_test.expect_error('Trạng thái Docker lạ bị từ chối',
  $$UPDATE docker_hosts SET state = 'running' WHERE server_id = 1$$, '23514');

SELECT itso_test.expect_ok('Tạo compose project hợp lệ',
  $$INSERT INTO compose_projects (id, server_id, name) VALUES (1, 1, 'cache')$$);
SELECT itso_test.expect_error('Tên project có ký tự lạ bị từ chối',
  $$INSERT INTO compose_projects (server_id, name) VALUES (1, '../etc')$$, '23514');
SELECT itso_test.expect_error('Tên project trùng trên cùng server bị từ chối',
  $$INSERT INTO compose_projects (server_id, name) VALUES (1, 'cache')$$, '23505');
SELECT itso_test.expect_ok('Cùng tên trên server khác được phép',
  $$INSERT INTO compose_projects (server_id, name) VALUES (2, 'cache')$$);

SELECT itso_test.expect_ok('Revision chưa validate (ok=false)',
  $$INSERT INTO compose_revisions (project_id, number, yaml) VALUES (1, 1, 'services: {}')$$);
SELECT itso_test.expect_error('Revision ok mà không có YAML đã validate bị từ chối',
  $$INSERT INTO compose_revisions (project_id, number, yaml, ok) VALUES (1, 2, 'services: {}', true)$$, '23514');
SELECT itso_test.expect_ok('Revision ok có YAML đã validate + sha256',
  $$INSERT INTO compose_revisions (project_id, number, yaml, validated_yaml, validated_sha256, ok)
    VALUES (1, 2, 'services: {}', 'services: {}', repeat('a', 64), true)$$);
SELECT itso_test.expect_error('Số revision trùng bị từ chối',
  $$INSERT INTO compose_revisions (project_id, number, yaml) VALUES (1, 2, 'x')$$, '23505');

SELECT itso_test.expect_ok('Cấp cổng 20011/tcp',
  $$INSERT INTO port_allocations (server_id, port, protocol, compose_project_id, service, container_port)
    VALUES (1, 20011, 'tcp', 1, 'redis', 6379)$$);
SELECT itso_test.expect_error('Cổng đã cấp trên cùng server bị từ chối',
  $$INSERT INTO port_allocations (server_id, port, protocol, compose_project_id, service, container_port)
    VALUES (1, 20011, 'tcp', 1, 'app', 80)$$, '23505');
SELECT itso_test.expect_ok('Cùng số cổng nhưng udp được phép',
  $$INSERT INTO port_allocations (server_id, port, protocol, compose_project_id, service, container_port)
    VALUES (1, 20011, 'udp', 1, 'dns', 53)$$);
SELECT itso_test.expect_error('Cổng 22 ngoài dải bị từ chối',
  $$INSERT INTO port_allocations (server_id, port, compose_project_id, service, container_port) VALUES (1, 22, 1, 'ssh', 22)$$, '23514');
SELECT itso_test.expect_error('Cổng 443 ngoài dải bị từ chối',
  $$INSERT INTO port_allocations (server_id, port, compose_project_id, service, container_port) VALUES (1, 443, 1, 'web', 443)$$, '23514');

SELECT itso_test.expect_ok('Ghi lần cập nhật image có bản rollback',
  $$INSERT INTO image_rollbacks (compose_project_id, service, from_digest, to_digest, rollback_tag, state)
    VALUES (1, 'redis', 'sha256:' || repeat('a', 64), 'sha256:' || repeat('b', 64), 'itso-rollback/cache-redis:20261122010000', 'rolled_back')$$);
SELECT itso_test.expect_error('Digest sai định dạng bị từ chối',
  $$INSERT INTO image_rollbacks (compose_project_id, service, from_digest, to_digest, rollback_tag)
    VALUES (1, 'redis', 'latest', 'sha256:' || repeat('b', 64), 'x')$$, '23514');

SELECT itso_test.expect_error('Website docker thiếu project/service bị từ chối',
  $$INSERT INTO websites (hosting_account_id, server_id, primary_domain, type) VALUES (1, 1, 'd.example.vn', 'docker')$$, '23514');
SELECT itso_test.expect_ok('Website docker gắn project + service',
  $$INSERT INTO websites (hosting_account_id, server_id, primary_domain, type, compose_project_id, compose_service)
    VALUES (1, 1, 'd.example.vn', 'docker', 1, 'redis')$$);
SELECT itso_test.expect_error('Website php không được mang compose_project',
  $$INSERT INTO websites (hosting_account_id, server_id, primary_domain, compose_project_id, compose_service)
    VALUES (1, 1, 'e.example.vn', 1, 'redis')$$, '23514');

SELECT itso_test.expect_ok('Site WordPress hợp lệ',
  $$INSERT INTO wordpress_sites (id, website_id, hosting_account_id, path) VALUES (1, 1, 1, 'sites/a.example.vn/public')$$);
SELECT itso_test.assert('WordPress mặc định tự cập nhật minor, cửa sổ 02:00-05:00',
  (SELECT auto_update = 'minor' AND update_window = '02:00-05:00' FROM wordpress_sites WHERE id = 1));
SELECT itso_test.expect_error('Đường dẫn WordPress tuyệt đối bị từ chối',
  $$UPDATE wordpress_sites SET path = '/var/www/html' WHERE id = 1$$, '23514');
SELECT itso_test.expect_error('Đường dẫn WordPress có .. bị từ chối',
  $$UPDATE wordpress_sites SET path = 'sites/../../etc' WHERE id = 1$$, '23514');
SELECT itso_test.expect_error('Chế độ tự cập nhật lạ bị từ chối',
  $$UPDATE wordpress_sites SET auto_update = 'major' WHERE id = 1$$, '23514');
SELECT itso_test.expect_error('Cửa sổ cập nhật sai định dạng bị từ chối',
  $$UPDATE wordpress_sites SET update_window = '2-5' WHERE id = 1$$, '23514');
SELECT itso_test.expect_error('Mỗi website chỉ một site WordPress',
  $$INSERT INTO wordpress_sites (website_id, hosting_account_id, path) VALUES (1, 1, 'x')$$, '23505');

SELECT itso_test.expect_ok('Thành phần core (slug null) và plugin',
  $$INSERT INTO wordpress_components (wordpress_site_id, type, slug, name, version) VALUES
    (1, 'core', NULL, 'WordPress', '6.7.1'), (1, 'plugin', 'wp-mail-smtp', 'WP Mail SMTP', '4.2.0')$$);
SELECT itso_test.expect_error('Core thứ hai bị từ chối',
  $$INSERT INTO wordpress_components (wordpress_site_id, type, slug, name, version) VALUES (1, 'core', NULL, 'WordPress', '6.7.2')$$, '23505');
SELECT itso_test.expect_error('Slug plugin chứa traversal bị từ chối',
  $$INSERT INTO wordpress_components (wordpress_site_id, type, slug, name, version) VALUES (1, 'plugin', '../x', 'x', '1')$$, '23514');
SELECT itso_test.expect_error('Plugin thiếu slug bị từ chối',
  $$INSERT INTO wordpress_components (wordpress_site_id, type, name, version) VALUES (1, 'plugin', 'x', '1')$$, '23514');

SELECT itso_test.expect_ok('Lịch sử cập nhật rolled_back',
  $$INSERT INTO wordpress_updates (wordpress_site_id, state, error) VALUES (1, 'rolled_back', 'verify: HTTP 500')$$);
SELECT itso_test.expect_error('Trạng thái cập nhật lạ bị từ chối',
  $$INSERT INTO wordpress_updates (wordpress_site_id, state) VALUES (1, 'done')$$, '23514');

SELECT itso_test.expect_ok('Catalog phần mềm có kho PPA ghim',
  $$INSERT INTO software_catalog (key, name, category, source, packages) VALUES ('php8.4', 'PHP 8.4', 'php', 'ppa-ondrej-php', '{php8.4-fpm}')$$);
SELECT itso_test.expect_error('Kho phần mềm lạ bị từ chối',
  $$INSERT INTO software_catalog (key, name, category, source) VALUES ('x', 'x', 'tools', 'docker-inc')$$, '23514');
SELECT itso_test.expect_ok('Phần mềm có bản nâng cấp',
  $$INSERT INTO server_software (server_id, software_key, version, latest_version, state, upgrade_available)
    VALUES (1, 'php8.2', '8.2.26', '8.2.27', 'upgradable', true)$$);
SELECT itso_test.expect_error('Trạng thái phần mềm lạ bị từ chối',
  $$UPDATE server_software SET state = 'broken' WHERE software_key = 'php8.2'$$, '23514');

SELECT itso_test.expect_ok('Policy backup phạm vi compose_project + docker_volumes',
  $$INSERT INTO backup_policies (name, scope_type, scope_id, contents, schedule) VALUES ('vol', 'compose_project', 1, '{docker_volumes}', '0 3 * * *')$$);
SELECT itso_test.assert('Policy volume mặc định pause',
  (SELECT volume_consistency FROM backup_policies WHERE name = 'vol') = 'pause');
SELECT itso_test.expect_error('Nhất quán volume lạ bị từ chối',
  $$UPDATE backup_policies SET volume_consistency = 'freeze' WHERE name = 'vol'$$, '23514');

SELECT itso_test.expect_ok('Rule firewall scope docker mở cổng container',
  $$INSERT INTO firewall_rules (server_id, priority, action, direction, protocol, port_range, scope) VALUES (1, 40, 'accept', 'in', 'tcp', '20001', 'docker')$$);
SELECT itso_test.assert('Rule firewall mặc định scope host',
  (SELECT scope FROM firewall_rules WHERE priority = 40 AND scope = 'docker') = 'docker'
  AND (SELECT column_default FROM information_schema.columns WHERE table_name = 'firewall_rules' AND column_name = 'scope') LIKE '%host%');
SELECT itso_test.expect_error('Rule docker chỉ accept/in (drop bị từ chối)',
  $$INSERT INTO firewall_rules (server_id, priority, action, direction, protocol, port_range, scope) VALUES (1, 41, 'drop', 'in', 'tcp', '20002', 'docker')$$, '23514');
SELECT itso_test.expect_error('Rule docker phải có cổng',
  $$INSERT INTO firewall_rules (server_id, priority, action, direction, protocol, scope) VALUES (1, 42, 'accept', 'in', 'tcp', 'docker')$$, '23514');

ROLLBACK;
