<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Auth\Permissions;
use App\Models\Permission;
use App\Models\Role;
use Illuminate\Database\Seeder;

/** Danh mục quyền + gán cho 3 vai trò (App\Auth\Permissions). Chạy lại được (đồng bộ theo code). */
class PermissionSeeder extends Seeder
{
    public function run(): void
    {
        foreach (Permissions::CATALOG as $group => $items) {
            foreach ($items as $key => $desc) {
                Permission::query()->updateOrCreate(['key' => $key], ['group_key' => $group, 'description' => $desc]);
            }
        }
        foreach (Permissions::ROLE_GRANTS as $roleKey => $keys) {
            $role = Role::query()->where('key', $roleKey)->firstOrFail();
            $ids = Permission::query()->whereIn('key', $keys)->pluck('id')->all();
            $role->permissions()->sync($ids);
        }
    }
}
