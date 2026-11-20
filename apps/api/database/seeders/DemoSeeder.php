<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Domain\Hosting\PackageLimits;
use App\Domain\Hosting\ProvisioningService;
use App\Domain\Hosting\UidAllocator;
use App\Domain\Servers\ServerFacts;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\HostingPackageVersion;
use App\Models\MfaCredential;
use App\Models\Role;
use App\Models\User;
use App\Models\UserScope;
use Illuminate\Database\Seeder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

/**
 * Dữ liệu demo cho các bảng Phase 3 (chỉ môi trường dev/test, runbook docs/runbooks/phase-3-demo.md):
 * người dùng mẫu (mật khẩu dev, MFA tắt trừ SUPER_ADMIN dùng secret dev), 3 gói theo contracts/examples/demo-dataset.json,
 * server local, 4 hosting account trên server local + job đồng bộ xuống agent (cần queue worker + mock agent).
 *
 *     php artisan db:seed --class=DemoSeeder
 */
class DemoSeeder extends Seeder
{
    public const PASSWORD = 'password-dev-only';

    /** Secret TOTP dev của superadmin@itso.local — CHỈ dùng local, ghi trong runbook. */
    public const SA_TOTP_SECRET = 'ITSODEVTOTPSECRETONLYFORLOCALDEV';

    private const USERS = [
        ['superadmin@itso.local', 'Quản trị hệ thống', 'admin', 'SUPER_ADMIN'],
        ['minh.tran@itso.local', 'Trần Minh', 'admin', 'ADMIN'],
        ['lan.pham@itso.local', 'Phạm Lan', 'admin', 'ADMIN'],
        ['it@anphat.vn', 'Công ty An Phát', 'portal', 'USER'],
        ['marketing@itso.vn', 'Phòng Marketing', 'portal', 'USER'],
        ['hoa.le@example.vn', 'Lê Hoa', 'portal', 'USER'],
    ];

    /** username → [chủ, gói, trạng thái] */
    private const ACCOUNTS = [
        'anphat' => ['it@anphat.vn', 'business', 'active'],
        'mktitso' => ['marketing@itso.vn', 'basic', 'active'],
        'lehoa' => ['hoa.le@example.vn', 'business', 'suspended'],
        'oldshop' => ['it@anphat.vn', 'business', 'terminated'],
    ];

    public function run(ServerFacts $servers, UidAllocator $uids, ProvisioningService $provisioning): void
    {
        if (app()->environment('production')) {
            throw new \RuntimeException('DemoSeeder không chạy ở production.');
        }
        $this->call([RoleSeeder::class, PermissionSeeder::class]);
        config(['itso.local_server.enabled' => true]);
        $server = $servers->ensureLocal();

        $hash = Hash::make(self::PASSWORD);
        $users = [];
        foreach (self::USERS as [$email, $name, $realm, $role]) {
            $u = User::query()->updateOrCreate(['email' => $email],
                ['realm' => $realm, 'name' => $name, 'password_hash' => $hash, 'status' => 'active', 'locale' => 'vi']);
            DB::table('user_roles')->where('user_id', $u->id)->delete();
            DB::table('user_roles')->insert(['user_id' => $u->id, 'role_id' => Role::query()->where('key', $role)->value('id')]);
            $users[$email] = $u;
        }
        $sa = $users['superadmin@itso.local'];
        if (! MfaCredential::query()->where('user_id', $sa->id)->where('type', 'totp')->exists()) {
            MfaCredential::query()->create(['user_id' => $sa->id, 'type' => 'totp', 'label' => 'Authenticator (dev)',
                'secret_encrypted' => Crypt::encryptString(self::SA_TOTP_SECRET)]);
        }
        UserScope::query()->firstOrCreate(['user_id' => $users['minh.tran@itso.local']->id, 'scope_type' => 'server',
            'scope_id' => $server->id]);

        $dataset = json_decode((string) file_get_contents(base_path('../../contracts/examples/demo-dataset.json')), true,
            512, JSON_THROW_ON_ERROR);
        $packages = [];
        foreach ($dataset['packages'] as $p) {
            $pkg = HostingPackage::query()->withTrashed()->firstOrCreate(['code' => $p['code']], [
                'name' => $p['name'], 'description' => $p['description'], 'current_version' => 1, 'is_active' => true]);
            if (! HostingPackageVersion::query()->where('package_id', $pkg->id)->exists()) {
                HostingPackageVersion::query()->create(array_merge(PackageLimits::columns($p['limits']),
                    ['package_id' => $pkg->id, 'version' => 1, 'created_by_user_id' => $sa->id]));
            }
            $packages[$p['code']] = $pkg;
        }

        foreach (self::ACCOUNTS as $username => [$owner, $code, $state]) {
            if (HostingAccount::query()->withTrashed()->where('server_id', $server->id)->where('username', $username)->exists()) {
                continue;
            }
            $a = DB::transaction(function () use ($uids, $provisioning, $server, $users, $owner, $packages, $code, $username, $state, $sa): HostingAccount {
                $uid = $uids->allocate($server->id);
                $now = Carbon::now();
                $a = HostingAccount::query()->create([
                    'server_id' => $server->id, 'package_version_id' => $provisioning->currentVersion($packages[$code])->id,
                    'owner_user_id' => $users[$owner]->id, 'username' => $username, 'uid' => $uid, 'home_path' => '/home/'.$username,
                    'lifecycle_state' => $state, 'status' => 'pending',
                    'suspended_reason' => $state === 'active' ? null : ($state === 'suspended' ? 'Chờ làm sạch mã độc (demo)' : 'Dự án kết thúc (demo)'),
                    'terminated_at' => $state === 'terminated' ? $now : null,
                    'purge_after' => $state === 'terminated' ? $now->copy()->addDays(30) : null,
                ]);
                $uids->bind($server->id, $uid, $a->id);
                $provisioning->event($a, null, $state, 'Dữ liệu demo', $sa, null);

                return $a;
            });
            $provisioning->reconcile($a, $sa);
        }
    }
}
