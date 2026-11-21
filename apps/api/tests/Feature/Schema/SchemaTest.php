<?php

use App\Models\AccountLifecycleEvent;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\Role;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

// Prompt 3.1: migration Phase 3 tạo đúng 26 bảng + ràng buộc/trigger của extras.sql. Prompt 4.5: thêm 6 bảng Phase 4. Prompt 5.1: thêm 9 bảng Phase 5. Prompt 6.1: thêm 10 bảng Phase 6.

const PHASE3_TABLES = [
    'users', 'roles', 'permissions', 'role_permissions', 'user_roles', 'user_scopes', 'mfa_credentials',
    'sessions', 'api_tokens', 'login_attempts', 'ip_allowlist', 'impersonation_sessions', 'tos_acceptances',
    'servers', 'agents', 'hosting_packages', 'hosting_package_versions', 'hosting_accounts',
    'account_lifecycle_events', 'uid_allocations', 'jobs', 'job_steps', 'job_logs', 'audit_logs',
    'notifications', 'settings',
];

const PHASE4_TABLES = ['server_services', 'server_capacity', 'software_catalog', 'server_software',
    'account_usage_snapshots', 'metric_samples'];

const PHASE5_TABLES = ['websites', 'domains', 'website_settings', 'acme_accounts', 'certificates', 'php_versions',
    'dns_providers', 'dns_zones', 'dns_records'];

const PHASE6_TABLES = ['databases', 'database_users', 'database_grants', 'sftp_accounts', 'ssh_keys', 'cron_jobs',
    'cron_runs', 'upload_sessions', 'file_operations', 'terminal_sessions'];

function rejects(callable $fn, string $pattern): void
{
    try {
        DB::transaction(fn () => $fn());
    } catch (QueryException $e) {
        expect($e->getMessage())->toMatch($pattern);

        return;
    }
    throw new RuntimeException('Mong đợi lỗi DB khớp '.$pattern);
}

it('tạo đủ 26 bảng Phase 3 + 6 bảng Phase 4 + 9 bảng Phase 5 + 10 bảng Phase 6 (không hơn), audit_logs và metric_samples có partition mặc định', function () {
    $tables = collect(DB::select("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))
        ->pluck('tablename')
        ->reject(fn ($t) => in_array($t, ['migrations', 'audit_logs_default', 'metric_samples_default'], true))
        ->sort()->values()->all();
    expect($tables)->toEqual(collect([...PHASE3_TABLES, ...PHASE4_TABLES, ...PHASE5_TABLES, ...PHASE6_TABLES])->sort()->values()->all());
    expect(DB::scalar("SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE c.relname = 'metric_samples_default'"))->toBe(1);
    expect(DB::scalar("SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE c.relname = 'audit_logs_default'"))->toBe(1);
});

it('seed 3 vai trò đúng realm; vai trò sai realm bị CHECK chặn', function () {
    expect(Role::query()->orderBy('key')->pluck('realm', 'key')->all())
        ->toBe(['ADMIN' => 'admin', 'SUPER_ADMIN' => 'admin', 'USER' => 'portal']);
    rejects(fn () => DB::table('roles')->insert(['key' => 'X', 'realm' => 'admin', 'name' => 'x']), '/roles_key_realm_chk/');
});

it('user: uuid do DB sinh có ngay sau create; realm bất biến; vai trò phải khớp realm', function () {
    $u = User::factory()->portalUser()->create();
    expect($u->uuid)->toMatch('/^[0-9a-f-]{36}$/')->and($u->roleKey())->toBe('USER');
    rejects(fn () => $u->forceFill(['realm' => 'admin'])->save(), '/realm là bất biến/');

    $admin = User::factory()->create(['realm' => 'admin']);
    $userRole = Role::query()->where('key', 'USER')->value('id');
    rejects(fn () => $admin->roles()->attach($userRole), '/không khớp user realm/');
});

it('email không phân biệt hoa thường (citext) và duy nhất', function () {
    User::factory()->create(['email' => 'An@Itso.vn']);
    rejects(fn () => User::factory()->create(['email' => 'an@itso.vn']), '/users_email_key/');
});

it('hosting account: chủ phải là USER portal, username/UID hợp lệ, terminated cần purge_after', function () {
    $acc = HostingAccount::factory()->create();
    expect($acc->uuid)->not->toBeNull()->and($acc->owner->realm)->toBe('portal');

    $admin = User::factory()->superAdmin()->create();
    rejects(fn () => HostingAccount::factory()->create(['owner_user_id' => $admin->id]), '/realm portal/');
    rejects(fn () => HostingAccount::factory()->create(['username' => 'Bad_Name']), '/hosting_accounts_username_chk/');
    rejects(fn () => HostingAccount::factory()->create(['uid' => 1000]), '/hosting_accounts_uid_chk/');
    rejects(fn () => $acc->forceFill(['lifecycle_state' => 'terminated'])->save(), '/hosting_accounts_terminate_chk/');
});

it('phiên bản gói bất biến; retention sau terminate tối thiểu 30 ngày', function () {
    $v = HostingPackage::factory()->create()->versions()->firstOrFail();
    expect($v->php_versions)->toBe(['8.2', '8.3']);
    rejects(fn () => $v->forceFill(['disk_mb' => 1])->save(), '/bất biến/');
    rejects(fn () => $v->delete(), '/bất biến/');
    rejects(fn () => DB::table('hosting_package_versions')->insert(array_merge(
        collect($v->getAttributes())->except(['id', 'created_at'])->all(),
        ['version' => 2, 'retention_days_after_terminate' => 7],
    )), '/hpv_positive_chk/');
});

it('audit log append-only, chuỗi hash nối tiếp và khớp nội dung', function () {
    foreach (['login', 'user.create', 'logout'] as $action) {
        DB::table('audit_logs')->insert(['action' => $action, 'result' => 'success', 'changes' => json_encode(['a' => 1])]);
    }
    $rows = DB::table('audit_logs')->orderBy('id')->get();
    expect($rows)->toHaveCount(3)
        ->and($rows[0]->prev_hash)->toBeNull()
        ->and($rows[1]->prev_hash)->toBe($rows[0]->hash)
        ->and($rows[2]->prev_hash)->toBe($rows[1]->hash);
    rejects(fn () => DB::table('audit_logs')->where('id', $rows[0]->id)->update(['action' => 'x']), '/append-only/');
    rejects(fn () => DB::table('audit_logs')->delete(), '/append-only/');
});

it('lịch sử vòng đời account append-only', function () {
    $acc = HostingAccount::factory()->create();
    $e = AccountLifecycleEvent::query()->create(['hosting_account_id' => $acc->id, 'from_state' => 'pending', 'to_state' => 'active']);
    rejects(fn () => $e->forceFill(['reason' => 'sửa'])->save(), '/append-only/');
});

it('job: trạng thái và tiến độ trong miền cho phép', function () {
    rejects(fn () => DB::table('jobs')->insert(['type' => 'x', 'state' => 'weird']), '/jobs_state_chk/');
    rejects(fn () => DB::table('jobs')->insert(['type' => 'x', 'state' => 'queued', 'progress' => 101]), '/jobs_progress_chk/');
});

it('Phase 5: domain duy nhất khi còn hoạt động, chữ thường; khóa ACME chỉ ở agent hoặc db (D-69)', function () {
    $acc = HostingAccount::factory()->create();
    $site = DB::table('websites')->insertGetId(['hosting_account_id' => $acc->id, 'server_id' => $acc->server_id,
        'primary_domain' => 'shop.anphat.vn'], 'id');
    DB::table('domains')->insert(['website_id' => $site, 'name' => 'www.anphat.vn']);
    rejects(fn () => DB::table('domains')->insert(['website_id' => $site, 'name' => 'www.anphat.vn']), '/domains_name_active_uq/');
    rejects(fn () => DB::table('domains')->insert(['website_id' => $site, 'name' => 'WWW.Other.vn']), '/domains_lowercase_chk/');
    DB::table('domains')->where('name', 'www.anphat.vn')->update(['deleted_at' => now()]);
    DB::table('domains')->insert(['website_id' => $site, 'name' => 'www.anphat.vn']);
    expect(DB::table('domains')->where('name', 'www.anphat.vn')->count())->toBe(2);

    DB::table('acme_accounts')->insert(['server_id' => $acc->server_id, 'email' => 'it@anphat.vn',
        'directory_url' => 'https://acme-v02.api.letsencrypt.org/directory']);
    rejects(fn () => DB::table('acme_accounts')->insert(['server_id' => $acc->server_id, 'email' => 'x@anphat.vn',
        'directory_url' => 'https://acme-staging-v02.api.letsencrypt.org/directory', 'key_location' => 'db']), '/acme_accounts_key_chk/');
});

it('Phase 6: tên DB/DB user hợp lệ và duy nhất khi chưa xóa; upload không vượt kích thước; trạng thái trong miền', function () {
    $acc = HostingAccount::factory()->create();
    $base = ['hosting_account_id' => $acc->id, 'server_id' => $acc->server_id, 'engine' => 'mariadb'];
    DB::table('databases')->insert($base + ['name' => 'anphat_web']);
    rejects(fn () => DB::table('databases')->insert($base + ['name' => 'anphat_web']), '/databases_name_active_uq/');
    rejects(fn () => DB::table('databases')->insert($base + ['name' => 'anphat_web; DROP']), '/databases_name_chk/');
    DB::table('databases')->where('name', 'anphat_web')->update(['deleted_at' => now()]);
    DB::table('databases')->insert($base + ['name' => 'anphat_web']);

    DB::table('database_users')->insert($base + ['username' => 'anphat_web']);
    rejects(fn () => DB::table('database_users')->insert($base + ['username' => 'anphat_web']), '/database_users_name_active_uq/');
    rejects(fn () => DB::table('database_users')->insert($base + ['username' => 'anphat_x', 'host_pattern' => '10.0.0.%']), '/database_users_host_chk/');

    $user = User::factory()->portalUser()->create();
    rejects(fn () => DB::table('upload_sessions')->insert(['user_id' => $user->id, 'hosting_account_id' => $acc->id,
        'target_path' => 'a.bin', 'size_bytes' => 10, 'received_bytes' => 11, 'expires_at' => now()]), '/upload_sessions_bytes_chk/');
    rejects(fn () => DB::table('file_operations')->insert(['hosting_account_id' => $acc->id, 'op' => 'exec']), '/file_operations_op_chk/');

    $cron = DB::table('cron_jobs')->insertGetId(['hosting_account_id' => $acc->id, 'schedule' => '*/5 * * * *',
        'command' => 'php artisan schedule:run'], 'id');
    rejects(fn () => DB::table('cron_runs')->insert(['cron_job_id' => $cron, 'started_at' => now(), 'status' => 'weird']), '/cron_runs_status_chk/');
});
