<?php

use App\Http\Controllers\Api\V1\Auth\AuthController;
use App\Http\Controllers\Api\V1\Auth\MfaController;
use App\Http\Controllers\Api\V1\Auth\PasswordController;
use App\Http\Controllers\Api\V1\Auth\SessionController;
use App\Http\Controllers\Api\V1\SystemController;
use Illuminate\Support\Facades\Route;

// Tiền tố /api do bootstrap/app.php thêm. Hợp đồng: contracts/openapi/itso-{admin,portal}-v1.yaml.
// Nhóm `itso.web` (bootstrap/app.php): realm → cookie phiên theo realm → session → CSRF → IP allowlist.

Route::prefix('v1')->group(function (): void {
    Route::get('system/health', [SystemController::class, 'health']);

    Route::middleware('itso.web')->group(function (): void {
        // ---- /auth: realm theo host hoặc header X-ITSO-Realm (D-58)
        Route::prefix('auth')->group(function (): void {
            Route::get('csrf', [AuthController::class, 'csrf']);
            Route::post('login', [AuthController::class, 'login']);
            Route::post('mfa/verify', [MfaController::class, 'verify']);
            Route::post('password:forgot', [PasswordController::class, 'forgot']);
            Route::post('password:reset', [PasswordController::class, 'reset']);

            Route::middleware('itso.auth')->group(function (): void {
                // Không cần MFA: để user chưa xác minh / SUPER_ADMIN chưa bật MFA tự xử lý.
                Route::post('logout', [AuthController::class, 'logout']);
                Route::get('me', [AuthController::class, 'me']);
                Route::post('mfa/totp:enroll', [MfaController::class, 'enroll']);
                Route::post('mfa/totp:confirm', [MfaController::class, 'confirm']);
                Route::post('step-up', [MfaController::class, 'stepUp']);

                Route::middleware('itso.mfa')->group(function (): void {
                    Route::get('sessions', [SessionController::class, 'index']);
                    Route::delete('sessions/{id}', [SessionController::class, 'destroy']);
                    Route::post('password:change', [PasswordController::class, 'change']);
                });
            });
        });

        // ---- /admin: realm admin (phiên cookie hoặc API token)
        Route::prefix('admin')->middleware(['itso.auth:admin', 'itso.mfa'])->group(function (): void {
            Route::prefix('system')->middleware('itso.scope:system:read')->group(function (): void {
                Route::get('version', [SystemController::class, 'version']);
                Route::get('status', [SystemController::class, 'status']);
            });
        });

        // ---- /portal: realm portal (chỉ phiên cookie)
        Route::prefix('portal')->middleware(['itso.auth:portal', 'itso.mfa'])->group(function (): void {
            // Endpoint portal: Prompt 3.5.
        });
    });
});
