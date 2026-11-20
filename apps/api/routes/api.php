<?php

use App\Http\Controllers\Api\V1\SystemController;
use Illuminate\Support\Facades\Route;

// Tiền tố /api do bootstrap/app.php thêm. Hợp đồng: contracts/openapi/itso-{admin,portal}-v1.yaml.

Route::prefix('v1')->group(function (): void {
    Route::get('system/health', [SystemController::class, 'health']);

    // Chưa có auth/RBAC (Phase 3) → các route admin/system chỉ bật ở local/testing.
    // Khi bật auth, nhóm này chuyển vào middleware realm admin và bỏ điều kiện môi trường.
    if (app()->environment(config('itso.dev_routes_envs'))) {
        Route::prefix('admin/system')->group(function (): void {
            Route::get('version', [SystemController::class, 'version']);
            Route::get('status', [SystemController::class, 'status']);
        });
    }
});
