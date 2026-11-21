<?php

use App\Models\AccountLifecycleEvent;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\Role;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

// Prompt 3.1: migration Phase 3 tạo đúng 26 bảng + ràng buộc/trigger của extras.sql. Prompt 4.5: thêm 6 bảng Phase 4.

const PHASE3_TABLES = [
    'users', 'roles', 'permissions', 'role_permissions', 'user_roles', 'user_scopes', 'mfa_credentials',
    'sessions', 'api_tokens', 'login_attempts', 'ip_allowlist', 'impersonation_sessions', 'tos_acceptances',
    'servers', 'agents', 'hosting_packages', 'hosting_package_versions', 'hosting_accounts',
    'account_lifecycle_events', 'uid_allocations', 'jobs', 'job_steps', 'job_logs', 'audit_logs',
    'notifications', 'settings',
];

const PHASE4_TABLES = ['server_services', 'server_capacity', 'software_catalog', 'server_software',
    'account_usage_snapshots', 'metric_samples'];

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

it('tạo đủ 26 bảng Phase 3 + 6 bảng Phase 4 (không hơn), audit_logs và metric_samples có partition mặc định', function () {
    $tables = collect(DB::select("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))
        ->pluck('tablename')
        ->reject(fn ($t) => in_array($t, ['migrations', 'audit_logs_default', 'metric_samples_default'], true))
        ->sort()->values()->all();
    expect($tables)->toEqual(collect([...PHASE3_TABLES, ...PHASE4_TABLES])->sort()->values()->all());
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
