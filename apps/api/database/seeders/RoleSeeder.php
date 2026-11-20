<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Models\Role;
use Illuminate\Database\Seeder;

/** Ba vai trò cố định (CHECK roles_key_realm_chk). Quyền chi tiết: PermissionSeeder (Prompt 3.3). */
class RoleSeeder extends Seeder
{
    public const ROLES = [
        ['key' => 'SUPER_ADMIN', 'realm' => 'admin', 'name' => 'Super Admin'],
        ['key' => 'ADMIN', 'realm' => 'admin', 'name' => 'Admin'],
        ['key' => 'USER', 'realm' => 'portal', 'name' => 'Người dùng'],
    ];

    public function run(): void
    {
        foreach (self::ROLES as $r) {
            Role::query()->updateOrCreate(['key' => $r['key']], $r);
        }
    }
}
