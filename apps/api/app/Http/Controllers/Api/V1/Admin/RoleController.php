<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Models\Role;
use Illuminate\Http\JsonResponse;

/** GET /admin/roles: 3 vai trò cố định và quyền (seed từ App\Auth\Permissions). */
final class RoleController
{
    public function index(): JsonResponse
    {
        $order = ['SUPER_ADMIN' => 0, 'ADMIN' => 1, 'USER' => 2];
        $data = Role::query()->with('permissions')->get()
            ->sortBy(fn (Role $r): int => $order[$r->key] ?? 9)
            ->map(fn (Role $r): array => [
                'key' => $r->key, 'realm' => $r->realm, 'name' => $r->name,
                'permissions' => $r->permissions->pluck('key')->sort()->values()->all(),
            ])->values()->all();

        return response()->json(['data' => $data, 'meta' => ['next_cursor' => null, 'limit' => max(1, count($data))]]);
    }
}
