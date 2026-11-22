-- ITSO Panel — ràng buộc bổ sung mà DBML không biểu diễn được.
-- Áp dụng SAU itso.sql. Viết tay, được kiểm thử bởi database/tests/*.sql.

-- ============================================================ CHECK: giá trị liệt kê
ALTER TABLE users ADD CONSTRAINT users_realm_chk CHECK (realm IN ('admin', 'portal'));
ALTER TABLE users ADD CONSTRAINT users_status_chk CHECK (status IN ('active', 'locked', 'disabled'));
ALTER TABLE roles ADD CONSTRAINT roles_key_realm_chk CHECK (
  (key IN ('SUPER_ADMIN', 'ADMIN') AND realm = 'admin') OR (key = 'USER' AND realm = 'portal')
);
ALTER TABLE user_scopes ADD CONSTRAINT user_scopes_type_chk CHECK (scope_type IN ('server', 'hosting_account'));
ALTER TABLE mfa_credentials ADD CONSTRAINT mfa_type_chk CHECK (type IN ('totp', 'webauthn', 'recovery'));
ALTER TABLE ip_allowlist ADD CONSTRAINT ip_allowlist_scope_chk CHECK (scope IN ('admin', 'api'));

ALTER TABLE servers ADD CONSTRAINT servers_status_chk
  CHECK (status IN ('pending', 'provisioning', 'ready', 'degraded', 'failed', 'suspended', 'deleting'));
ALTER TABLE agents ADD CONSTRAINT agents_transport_chk CHECK (transport IN ('local', 'mtls'));

ALTER TABLE hosting_accounts ADD CONSTRAINT hosting_accounts_lifecycle_chk CHECK (
  lifecycle_state IN ('pending', 'provisioning', 'active', 'suspended', 'migrating', 'terminated', 'purged', 'failed')
);
ALTER TABLE hosting_accounts ADD CONSTRAINT hosting_accounts_username_chk
  CHECK (username ~ '^[a-z][a-z0-9]{2,15}$');
ALTER TABLE hosting_accounts ADD CONSTRAINT hosting_accounts_uid_chk CHECK (uid BETWEEN 20000 AND 59999);
ALTER TABLE hosting_accounts ADD CONSTRAINT hosting_accounts_terminate_chk CHECK (
  lifecycle_state NOT IN ('terminated', 'purged') OR (terminated_at IS NOT NULL AND purge_after IS NOT NULL)
);
ALTER TABLE uid_allocations ADD CONSTRAINT uid_allocations_range_chk CHECK (uid BETWEEN 20000 AND 59999);

ALTER TABLE hosting_package_versions ADD CONSTRAINT hpv_positive_chk CHECK (
  disk_mb > 0 AND inode_limit > 0 AND cpu_percent > 0 AND ram_mb > 0 AND tasks_max > 0
  AND php_workers_max > 0 AND website_limit >= 0 AND database_limit >= 0 AND cron_min_interval_min >= 1
  AND retention_days_after_terminate >= 30
);

ALTER TABLE account_migrations ADD CONSTRAINT account_migrations_state_chk CHECK (
  state IN ('preflight', 'syncing', 'verifying', 'cutover', 'holding', 'completed', 'rolled_back', 'failed')
);
ALTER TABLE account_migrations ADD CONSTRAINT account_migrations_keep_chk CHECK (keep_source_days BETWEEN 1 AND 30);
-- Mỗi account chỉ có một lần chuyển chưa kết thúc (D-93).
CREATE UNIQUE INDEX account_migrations_one_open ON account_migrations (hosting_account_id)
  WHERE state IN ('preflight', 'syncing', 'verifying', 'cutover', 'holding');
ALTER TABLE account_migrations ADD CONSTRAINT account_migrations_diff_server_chk
  CHECK (source_server_id <> target_server_id);

ALTER TABLE websites ADD CONSTRAINT websites_type_chk CHECK (type IN ('php', 'static', 'proxy', 'docker'));
ALTER TABLE websites ADD CONSTRAINT websites_ssl_chk CHECK (ssl_mode IN ('none', 'acme', 'custom'));
ALTER TABLE domains ADD CONSTRAINT domains_lowercase_chk CHECK (name = lower(name));
ALTER TABLE domains ADD CONSTRAINT domains_type_chk CHECK (type IN ('primary', 'alias', 'redirect', 'subdomain'));
ALTER TABLE databases ADD CONSTRAINT databases_engine_chk CHECK (engine IN ('mariadb', 'mysql', 'postgresql'));
ALTER TABLE sftp_accounts ADD CONSTRAINT sftp_protocol_chk CHECK (protocol IN ('sftp', 'ftps'));
ALTER TABLE databases ADD CONSTRAINT databases_name_chk CHECK (name ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE database_users ADD CONSTRAINT database_users_name_chk CHECK (username ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE database_users ADD CONSTRAINT database_users_host_chk CHECK (host_pattern IN ('localhost', '%'));
ALTER TABLE cron_runs ADD CONSTRAINT cron_runs_status_chk CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out'));
ALTER TABLE cron_runs ADD CONSTRAINT cron_runs_trigger_chk CHECK (trigger IN ('schedule', 'manual'));
ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_status_chk
  CHECK (status IN ('receiving', 'committing', 'completed', 'failed', 'cancelled'));
ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_bytes_chk CHECK (received_bytes BETWEEN 0 AND size_bytes);
ALTER TABLE file_operations ADD CONSTRAINT file_operations_op_chk
  CHECK (op IN ('write', 'mkdir', 'rename', 'move', 'copy', 'delete', 'chmod', 'compress', 'extract', 'upload'));
ALTER TABLE terminal_sessions ADD CONSTRAINT terminal_sessions_mode_chk CHECK (mode IN ('account', 'root'));
ALTER TABLE certificates ADD CONSTRAINT certificates_source_chk CHECK (source IN ('acme', 'upload'));
ALTER TABLE acme_accounts ADD CONSTRAINT acme_accounts_key_chk CHECK ((key_location = 'agent' AND key_encrypted IS NULL) OR (key_location = 'db' AND key_encrypted IS NOT NULL));

ALTER TABLE backup_destinations ADD CONSTRAINT backup_dest_type_chk CHECK (type IN ('local', 'sftp', 's3', 'rest'));
ALTER TABLE restore_jobs ADD CONSTRAINT restore_mode_chk CHECK (mode IN ('new', 'overwrite'));
ALTER TABLE backup_repositories ADD CONSTRAINT backup_repo_scope_chk CHECK (
  (scope_type = 'hosting_account' AND hosting_account_id IS NOT NULL) OR (scope_type = 'server' AND hosting_account_id IS NULL)
);
ALTER TABLE backup_repositories ADD CONSTRAINT backup_repo_quota_chk CHECK (quota_state IN ('ok', 'warn', 'paused'));
ALTER TABLE backup_repositories ADD CONSTRAINT backup_repo_path_chk CHECK (path ~ '^itso/[0-9a-f-]{36}/(acct-[0-9a-f-]{36}|server)$');
ALTER TABLE backup_policies ADD CONSTRAINT backup_policy_scope_chk
  CHECK (scope_type IN ('all_accounts', 'hosting_account', 'website', 'database', 'server', 'panel'));
ALTER TABLE backup_policies ADD CONSTRAINT backup_policy_contents_chk CHECK (contents <@ ARRAY['files', 'databases', 'config']::text[]);
ALTER TABLE backup_policies ADD CONSTRAINT backup_policy_excludes_chk CHECK (cardinality(excludes) <= 50);
ALTER TABLE backup_snapshots ADD CONSTRAINT backup_snapshot_scope_chk
  CHECK (scope_type IN ('hosting_account', 'website', 'database', 'server_config', 'panel'));
ALTER TABLE backup_snapshots ADD CONSTRAINT backup_snapshot_id_chk CHECK (restic_snapshot_id ~ '^[0-9a-f]{8,64}$');
ALTER TABLE backup_verifications ADD CONSTRAINT backup_verif_kind_chk CHECK (kind IN ('check', 'restore_test'));
ALTER TABLE backup_verifications ADD CONSTRAINT backup_verif_state_chk CHECK (state IN ('running', 'succeeded', 'failed'));
CREATE UNIQUE INDEX backup_repositories_account_uq ON backup_repositories (destination_id, server_id, hosting_account_id)
  WHERE deleted_at IS NULL AND hosting_account_id IS NOT NULL;
CREATE UNIQUE INDEX backup_repositories_server_uq ON backup_repositories (destination_id, server_id)
  WHERE deleted_at IS NULL AND hosting_account_id IS NULL;

ALTER TABLE jobs ADD CONSTRAINT jobs_state_chk CHECK (
  state IN ('queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'timed_out')
);
ALTER TABLE jobs ADD CONSTRAINT jobs_progress_chk CHECK (progress BETWEEN 0 AND 100);

ALTER TABLE security_events ADD CONSTRAINT security_events_severity_chk
  CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical'));
ALTER TABLE firewall_rules ADD CONSTRAINT firewall_action_chk CHECK (action IN ('accept', 'drop', 'reject'));

-- ============================================================ Partial unique (soft-delete)
-- Domain là duy nhất toàn hệ thống trong số bản ghi chưa xóa (cả domain chính và domain phụ).
CREATE UNIQUE INDEX domains_name_active_uq ON domains (name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX websites_primary_domain_active_uq ON websites (primary_domain) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX databases_name_active_uq ON databases (server_id, engine, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX sftp_username_active_uq ON sftp_accounts (username) WHERE deleted_at IS NULL;
-- Phase 6: DB user duy nhất theo server + engine khi chưa xóa (thay unique toàn phần, cho tạo lại sau khi xóa).
CREATE UNIQUE INDEX database_users_name_active_uq ON database_users (server_id, engine, username) WHERE deleted_at IS NULL;
-- Một UID chỉ được cấp cho một account đang giữ (chưa release) trên mỗi server — đã có unique (server_id, uid).

-- Tìm kiếm mờ theo domain
CREATE INDEX domains_name_trgm ON domains USING gin (name gin_trgm_ops);

-- ============================================================ Trigger: realm bất biến + vai trò khớp realm
CREATE OR REPLACE FUNCTION itso_users_realm_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.realm IS DISTINCT FROM OLD.realm THEN
    RAISE EXCEPTION 'users.realm là bất biến (user %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_realm_immutable BEFORE UPDATE OF realm ON users
  FOR EACH ROW EXECUTE FUNCTION itso_users_realm_immutable();

CREATE OR REPLACE FUNCTION itso_user_roles_realm_match() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u_realm text; r_realm text;
BEGIN
  SELECT realm INTO u_realm FROM users WHERE id = NEW.user_id;
  SELECT realm INTO r_realm FROM roles WHERE id = NEW.role_id;
  IF u_realm IS DISTINCT FROM r_realm THEN
    RAISE EXCEPTION 'Vai trò realm % không khớp user realm %', r_realm, u_realm USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_roles_realm_match BEFORE INSERT OR UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION itso_user_roles_realm_match();

-- Chủ sở hữu hosting account phải là user realm portal
CREATE OR REPLACE FUNCTION itso_hosting_owner_portal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT realm FROM users WHERE id = NEW.owner_user_id) <> 'portal' THEN
    RAISE EXCEPTION 'owner_user_id phải là user realm portal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hosting_owner_portal BEFORE INSERT OR UPDATE OF owner_user_id ON hosting_accounts
  FOR EACH ROW EXECUTE FUNCTION itso_hosting_owner_portal();

-- ============================================================ Trigger: purge an toàn (D-46)
-- Chỉ được chuyển sang 'purged' khi: không legal hold, đã quá purge_after, và có purge_record
-- đã xác nhận với backup cuối đã xác minh.
CREATE OR REPLACE FUNCTION itso_hosting_purge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle_state = 'purged' AND OLD.lifecycle_state IS DISTINCT FROM 'purged' THEN
    IF OLD.lifecycle_state <> 'terminated' THEN
      RAISE EXCEPTION 'Chỉ purge được account ở trạng thái terminated' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.legal_hold THEN
      RAISE EXCEPTION 'Account đang legal hold, không được purge' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.purge_after > now() THEN
      RAISE EXCEPTION 'Chưa hết thời gian giữ dữ liệu (purge_after = %)', NEW.purge_after USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM purge_records pr
      WHERE pr.hosting_account_id = NEW.id
        AND pr.confirmed_by_user_id IS NOT NULL
        AND pr.confirmed_by_user_id <> pr.requested_by_user_id
        AND pr.backup_verified_at IS NOT NULL
        AND pr.final_backup_snapshot_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Thiếu biên bản purge đã xác nhận 2 bước và backup cuối đã xác minh' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hosting_purge_guard BEFORE UPDATE OF lifecycle_state ON hosting_accounts
  FOR EACH ROW EXECUTE FUNCTION itso_hosting_purge_guard();

-- Package version bất biến (D-43)
CREATE OR REPLACE FUNCTION itso_reject_modify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% là bảng bất biến/append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER hosting_package_versions_immutable BEFORE UPDATE OR DELETE ON hosting_package_versions
  FOR EACH ROW EXECUTE FUNCTION itso_reject_modify();

-- ============================================================ Audit log: append-only + hash chain
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION itso_reject_modify();
CREATE TRIGGER account_lifecycle_events_append_only BEFORE UPDATE OR DELETE ON account_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION itso_reject_modify();

CREATE OR REPLACE FUNCTION itso_audit_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Khóa tư vấn tuần tự hóa việc ghi để chuỗi hash liên tục.
  PERFORM pg_advisory_xact_lock(hashtext('itso_audit_chain'));
  SELECT hash INTO NEW.prev_hash FROM audit_logs ORDER BY at DESC, id DESC LIMIT 1;
  NEW.hash := encode(sha256(convert_to(
    coalesce(NEW.prev_hash, '') || '|' || NEW.at::text || '|' || coalesce(NEW.actor_user_id::text, '') || '|' ||
    NEW.action || '|' || coalesce(NEW.resource_type, '') || '|' || coalesce(NEW.resource_id::text, '') || '|' ||
    coalesce(NEW.changes::text, ''), 'UTF8')), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_logs_hash BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION itso_audit_hash();

-- ============================================================ Partition
-- Partition mặc định để không bao giờ mất bản ghi; scheduler (Phase 3/11) tạo partition theo tháng/ngày.
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
CREATE TABLE metric_samples_default PARTITION OF metric_samples DEFAULT;

CREATE OR REPLACE FUNCTION itso_ensure_audit_partition(p_month date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  start_d date := date_trunc('month', p_month)::date;
  end_d date := (date_trunc('month', p_month) + interval '1 month')::date;
  part text := format('audit_logs_%s', to_char(start_d, 'YYYYMM'));
BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)', part, start_d, end_d);
  RETURN part;
END $$;

CREATE OR REPLACE FUNCTION itso_ensure_metric_partition(p_day date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE part text := format('metric_samples_%s', to_char(p_day, 'YYYYMMDD'));
BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF metric_samples FOR VALUES FROM (%L) TO (%L)',
                 part, p_day, p_day + 1);
  RETURN part;
END $$;

-- ============================================================ Phase 7: Security Center (D-76…D-81)
ALTER TABLE firewall_applies ADD CONSTRAINT firewall_applies_target_chk CHECK (target IN ('firewall', 'sshd'));
ALTER TABLE firewall_applies ADD CONSTRAINT firewall_applies_status_chk
  CHECK (status IN ('pending_confirm', 'confirmed', 'rolled_back', 'failed'));
-- Mỗi máy chủ chỉ có một lần safe-apply đang chờ xác nhận cho mỗi loại (firewall/sshd).
CREATE UNIQUE INDEX firewall_applies_one_pending ON firewall_applies (server_id, target) WHERE status = 'pending_confirm';
ALTER TABLE waf_settings ADD CONSTRAINT waf_settings_mode_chk CHECK (mode IN ('DetectionOnly', 'On', 'Off'));
ALTER TABLE waf_settings ADD CONSTRAINT waf_settings_paranoia_chk CHECK (paranoia_level BETWEEN 1 AND 4);
ALTER TABLE waf_events ADD CONSTRAINT waf_events_action_chk CHECK (action IN ('detected', 'blocked'));
ALTER TABLE fim_changes ADD CONSTRAINT fim_changes_change_chk CHECK (change IN ('added', 'modified', 'removed', 'metadata'));
ALTER TABLE terminal_recordings ADD CONSTRAINT terminal_recordings_mode_chk CHECK (mode IN ('account', 'root'));
ALTER TABLE firewall_rules ADD CONSTRAINT firewall_rules_direction_chk CHECK (direction IN ('in', 'out'));
ALTER TABLE firewall_rules ADD CONSTRAINT firewall_rules_protocol_chk CHECK (protocol IN ('tcp', 'udp', 'icmp', 'any'));
ALTER TABLE firewall_rules ADD CONSTRAINT firewall_rules_priority_chk CHECK (priority BETWEEN 1 AND 9999);
ALTER TABLE malware_findings ADD CONSTRAINT malware_findings_engine_chk CHECK (engine IN ('clamav', 'yara'));
ALTER TABLE malware_findings ADD CONSTRAINT malware_findings_action_chk
  CHECK (action IN ('none', 'quarantined', 'restored', 'deleted'));
ALTER TABLE malware_findings ADD CONSTRAINT malware_findings_sha_chk CHECK (sha256 ~ '^[0-9a-f]{64}$');
CREATE TABLE waf_events_default PARTITION OF waf_events DEFAULT;

CREATE OR REPLACE FUNCTION itso_ensure_waf_partition(p_month date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  start_d date := date_trunc('month', p_month)::date;
  end_d date := (date_trunc('month', p_month) + interval '1 month')::date;
  part text := format('waf_events_%s', to_char(start_d, 'YYYYMM'));
BEGIN
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF waf_events FOR VALUES FROM (%L) TO (%L)', part, start_d, end_d);
  RETURN part;
END $$;

-- ============================================================ Phase 9: Multi-server (D-88…D-93)
-- Bảng của Phase trước: ALTER đánh dấu /* phase:9 */ để sinh vào migration Phase 9 (migration đã phát hành giữ nguyên).
/* phase:9 */ ALTER TABLE servers ADD COLUMN node_role text NOT NULL DEFAULT 'all_in_one';
/* phase:9 */ ALTER TABLE servers ADD CONSTRAINT servers_node_role_chk CHECK (node_role IN ('all_in_one', 'control_plane', 'node'));
/* phase:9 */ ALTER TABLE agents ADD COLUMN connection text NOT NULL DEFAULT 'pending';
/* phase:9 */ ALTER TABLE agents ADD CONSTRAINT agents_connection_chk
  CHECK (connection IN ('online', 'degraded', 'unreachable', 'pending', 'revoked'));
-- Khóa HMAC riêng mỗi server (D-89), mã hóa bằng APP_KEY; null với agent local (dùng /etc/itso/agent.key).
/* phase:9 */ ALTER TABLE agents ADD COLUMN hmac_key_encrypted bytea;
/* phase:9 */ ALTER TABLE agents ADD COLUMN cert_not_before timestamptz;
/* phase:9 */ ALTER TABLE agents ADD COLUMN cert_rotated_at timestamptz;
/* phase:9 */ ALTER TABLE agents ADD COLUMN revoked_at timestamptz;
-- Job chờ node kết nối lại tới hạn rồi lỗi agent_unreachable (D-91).
/* phase:9 */ ALTER TABLE jobs DROP CONSTRAINT jobs_state_chk;
/* phase:9 */ ALTER TABLE jobs ADD CONSTRAINT jobs_state_chk CHECK (
  state IN ('queued', 'waiting_agent', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'timed_out')
);
/* phase:9 */ ALTER TABLE jobs ADD COLUMN agent_deadline_at timestamptz;
ALTER TABLE agent_certificates ADD CONSTRAINT agent_certificates_reason_chk CHECK (issued_reason IN ('enroll', 'rotate', 'rejoin'));
ALTER TABLE agent_certificates ADD CONSTRAINT agent_certificates_fp_chk CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE agent_enrollment_tokens ADD CONSTRAINT agent_enrollment_tokens_hash_chk CHECK (token_hash ~ '^[0-9a-f]{64}$');

-- ============================================================ Phase 10: Docker, WordPress Toolkit, Software Manager (D-94…D-100)
-- Bảng của Phase trước: ALTER đánh dấu /* phase:10 */ (migration Phase 4/5/8 đã phát hành giữ nguyên).
/* phase:10 */ ALTER TABLE software_catalog ADD COLUMN packages text[] NOT NULL DEFAULT '{}';
/* phase:10 */ ALTER TABLE software_catalog ADD COLUMN source text NOT NULL DEFAULT 'ubuntu';
/* phase:10 */ ALTER TABLE software_catalog ADD CONSTRAINT software_catalog_source_chk CHECK (source IN ('ubuntu', 'ppa-ondrej-php', 'itso'));
/* phase:10 */ ALTER TABLE software_catalog ADD COLUMN service text;
/* phase:10 */ ALTER TABLE software_catalog ADD COLUMN core boolean NOT NULL DEFAULT false;
/* phase:10 */ ALTER TABLE software_catalog ADD COLUMN requires text[] NOT NULL DEFAULT '{}';
/* phase:10 */ ALTER TABLE server_software ADD COLUMN state text NOT NULL DEFAULT 'installed';
/* phase:10 */ ALTER TABLE server_software ADD CONSTRAINT server_software_state_chk
  CHECK (state IN ('available', 'installing', 'installed', 'upgradable', 'upgrading', 'removing', 'failed'));
/* phase:10 */ ALTER TABLE server_software ADD COLUMN latest_version text;
/* phase:10 */ ALTER TABLE server_software ADD COLUMN upgrade_available boolean NOT NULL DEFAULT false;
/* phase:10 */ ALTER TABLE websites ADD COLUMN compose_project_id bigint REFERENCES compose_projects (id);
/* phase:10 */ ALTER TABLE websites ADD COLUMN compose_service text;
/* phase:10 */ ALTER TABLE websites ADD CONSTRAINT websites_docker_target_chk CHECK (
  (type = 'docker') = (compose_project_id IS NOT NULL AND compose_service IS NOT NULL)
);
/* phase:10 */ ALTER TABLE backup_policies DROP CONSTRAINT backup_policy_scope_chk;
/* phase:10 */ ALTER TABLE backup_policies ADD CONSTRAINT backup_policy_scope_chk
  CHECK (scope_type IN ('all_accounts', 'hosting_account', 'website', 'database', 'server', 'panel', 'compose_project'));
/* phase:10 */ ALTER TABLE backup_policies DROP CONSTRAINT backup_policy_contents_chk;
/* phase:10 */ ALTER TABLE backup_policies ADD CONSTRAINT backup_policy_contents_chk
  CHECK (contents <@ ARRAY['files', 'databases', 'config', 'docker_volumes']::text[]);
/* phase:10 */ ALTER TABLE backup_policies ADD COLUMN volume_consistency text NOT NULL DEFAULT 'pause';
/* phase:10 */ ALTER TABLE backup_policies ADD CONSTRAINT backup_policy_volume_consistency_chk CHECK (volume_consistency IN ('pause', 'none'));
/* phase:10 */ ALTER TABLE firewall_rules ADD COLUMN scope text NOT NULL DEFAULT 'host';
/* phase:10 */ ALTER TABLE firewall_rules ADD CONSTRAINT firewall_rules_scope_chk CHECK (scope IN ('host', 'docker'));
-- Rule DOCKER-USER chỉ mở cổng vào (D-95): accept/in/tcp|udp, phải có cổng.
/* phase:10 */ ALTER TABLE firewall_rules ADD CONSTRAINT firewall_rules_docker_chk CHECK (
  scope = 'host' OR (action = 'accept' AND direction = 'in' AND protocol IN ('tcp', 'udp') AND port_range IS NOT NULL)
);
/* phase:10 */ ALTER TABLE backup_snapshots DROP CONSTRAINT backup_snapshot_scope_chk;
/* phase:10 */ ALTER TABLE backup_snapshots ADD CONSTRAINT backup_snapshot_scope_chk
  CHECK (scope_type IN ('hosting_account', 'website', 'database', 'server_config', 'panel', 'compose_project'));
ALTER TABLE docker_hosts ADD CONSTRAINT docker_hosts_state_chk CHECK (state IN ('not_installed', 'installing', 'enabled', 'degraded'));
ALTER TABLE docker_hosts ADD CONSTRAINT docker_hosts_range_chk CHECK (port_range_from >= 1024 AND port_range_from <= port_range_to AND port_range_to <= 65535);
ALTER TABLE compose_projects ADD CONSTRAINT compose_projects_name_chk CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,62}$');
ALTER TABLE compose_projects ADD CONSTRAINT compose_projects_run_state_chk CHECK (run_state IN ('running', 'stopped', 'partial', 'error', 'deploying'));
ALTER TABLE compose_revisions ADD CONSTRAINT compose_revisions_number_chk CHECK (number >= 1);
ALTER TABLE compose_revisions ADD CONSTRAINT compose_revisions_sha_chk CHECK (validated_sha256 IS NULL OR validated_sha256 ~ '^[0-9a-f]{64}$');
-- Revision không có YAML đã validate thì không thể ok (không có đường chạy YAML chưa qua validator, D-96).
ALTER TABLE compose_revisions ADD CONSTRAINT compose_revisions_ok_chk CHECK (NOT ok OR (validated_yaml IS NOT NULL AND validated_sha256 IS NOT NULL));
ALTER TABLE port_allocations ADD CONSTRAINT port_range_chk CHECK (port BETWEEN 20000 AND 29999);
ALTER TABLE port_allocations ADD CONSTRAINT port_protocol_chk CHECK (protocol IN ('tcp', 'udp'));
ALTER TABLE port_allocations ADD CONSTRAINT port_container_chk CHECK (container_port BETWEEN 1 AND 65535);
ALTER TABLE image_rollbacks ADD CONSTRAINT image_rollbacks_state_chk CHECK (state IN ('running', 'succeeded', 'rolled_back', 'failed'));
ALTER TABLE image_rollbacks ADD CONSTRAINT image_rollbacks_digest_chk
  CHECK (from_digest ~ '^sha256:[0-9a-f]{64}$' AND to_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE wordpress_sites ADD CONSTRAINT wordpress_sites_auto_update_chk CHECK (auto_update IN ('off', 'minor', 'all'));
ALTER TABLE wordpress_sites ADD CONSTRAINT wordpress_sites_state_chk CHECK (state IN ('ok', 'updating', 'cloning', 'maintenance', 'error'));
ALTER TABLE wordpress_sites ADD CONSTRAINT wordpress_sites_window_chk CHECK (update_window ~ '^([01][0-9]|2[0-3]):00-([01][0-9]|2[0-3]):00$');
ALTER TABLE wordpress_sites ADD CONSTRAINT wordpress_sites_path_chk CHECK (path !~ '(^/|(^|/)\.\.(/|$))');
ALTER TABLE wordpress_components ADD CONSTRAINT wordpress_components_type_chk CHECK (
  (type = 'core' AND slug IS NULL) OR (type IN ('plugin', 'theme') AND slug IS NOT NULL AND slug ~ '^[a-z0-9][a-z0-9_-]{0,99}$')
);
CREATE UNIQUE INDEX wordpress_components_core_uq ON wordpress_components (wordpress_site_id) WHERE type = 'core';
ALTER TABLE wordpress_updates ADD CONSTRAINT wordpress_updates_state_chk CHECK (state IN ('running', 'succeeded', 'rolled_back', 'failed'));
ALTER TABLE wordpress_updates ADD CONSTRAINT wordpress_updates_trigger_chk CHECK (trigger IN ('manual', 'auto'));
