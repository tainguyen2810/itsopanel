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
  state IN ('preflight', 'syncing', 'verifying', 'cutover', 'completed', 'rolled_back', 'failed')
);
ALTER TABLE account_migrations ADD CONSTRAINT account_migrations_diff_server_chk
  CHECK (source_server_id <> target_server_id);

ALTER TABLE websites ADD CONSTRAINT websites_type_chk CHECK (type IN ('php', 'static', 'proxy', 'docker'));
ALTER TABLE websites ADD CONSTRAINT websites_ssl_chk CHECK (ssl_mode IN ('none', 'acme', 'custom'));
ALTER TABLE domains ADD CONSTRAINT domains_lowercase_chk CHECK (name = lower(name));
ALTER TABLE domains ADD CONSTRAINT domains_type_chk CHECK (type IN ('primary', 'alias', 'redirect', 'subdomain'));
ALTER TABLE databases ADD CONSTRAINT databases_engine_chk CHECK (engine IN ('mariadb', 'mysql', 'postgresql'));
ALTER TABLE sftp_accounts ADD CONSTRAINT sftp_protocol_chk CHECK (protocol IN ('sftp', 'ftps'));
ALTER TABLE certificates ADD CONSTRAINT certificates_source_chk CHECK (source IN ('acme', 'upload'));
ALTER TABLE acme_accounts ADD CONSTRAINT acme_accounts_key_chk CHECK ((key_location = 'agent' AND key_encrypted IS NULL) OR (key_location = 'db' AND key_encrypted IS NOT NULL));

ALTER TABLE backup_destinations ADD CONSTRAINT backup_dest_type_chk CHECK (type IN ('local', 'sftp', 's3', 'rest'));
ALTER TABLE restore_jobs ADD CONSTRAINT restore_mode_chk CHECK (mode IN ('new', 'overwrite'));

ALTER TABLE jobs ADD CONSTRAINT jobs_state_chk CHECK (
  state IN ('queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'timed_out')
);
ALTER TABLE jobs ADD CONSTRAINT jobs_progress_chk CHECK (progress BETWEEN 0 AND 100);

ALTER TABLE security_events ADD CONSTRAINT security_events_severity_chk
  CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical'));
ALTER TABLE firewall_rules ADD CONSTRAINT firewall_action_chk CHECK (action IN ('accept', 'drop', 'reject'));
ALTER TABLE port_allocations ADD CONSTRAINT port_range_chk CHECK (port BETWEEN 1024 AND 65535);

-- ============================================================ Partial unique (soft-delete)
-- Domain là duy nhất toàn hệ thống trong số bản ghi chưa xóa (cả domain chính và domain phụ).
CREATE UNIQUE INDEX domains_name_active_uq ON domains (name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX websites_primary_domain_active_uq ON websites (primary_domain) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX databases_name_active_uq ON databases (server_id, engine, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX sftp_username_active_uq ON sftp_accounts (username) WHERE deleted_at IS NULL;
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
