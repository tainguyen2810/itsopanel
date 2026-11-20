<?php

use App\Http\Controllers\Api\V1\Admin\ApiTokenController;
use App\Http\Controllers\Api\V1\Admin\ImpersonationController;
use App\Http\Controllers\Api\V1\Admin\RoleController;
use App\Http\Controllers\Api\V1\Admin\UserController;
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
            Route::post('impersonation:accept', [ImpersonationController::class, 'accept']);

            Route::middleware('itso.auth')->group(function (): void {
                // Không cần MFA: để user chưa xác minh / SUPER_ADMIN chưa bật MFA tự xử lý.
                Route::post('logout', [AuthController::class, 'logout']);
                Route::get('me', [AuthController::class, 'me']);
                Route::post('impersonation:end', [ImpersonationController::class, 'end']);
                Route::middleware('itso.self')->group(function (): void {
                    Route::post('mfa/totp:enroll', [MfaController::class, 'enroll']);
                    Route::post('mfa/totp:confirm', [MfaController::class, 'confirm']);
                    Route::post('step-up', [MfaController::class, 'stepUp']);
                });

                Route::middleware('itso.mfa')->group(function (): void {
                    Route::get('sessions', [SessionController::class, 'index']);
                    Route::middleware('itso.self')->group(function (): void {
                        Route::delete('sessions/{id}', [SessionController::class, 'destroy']);
                        Route::post('password:change', [PasswordController::class, 'change']);
                    });
                });
            });
        });

        // ---- /admin: realm admin (phiên cookie hoặc API token)
        Route::prefix('admin')->middleware(['itso.auth:admin', 'itso.mfa'])->group(function (): void {
            Route::prefix('system')->middleware('itso.scope:system:read')->group(function (): void {
                Route::get('version', [SystemController::class, 'version']);
                Route::get('status', [SystemController::class, 'status']);
            });

            // Người dùng, vai trò, giả danh (3.3)
            Route::get('users', [UserController::class, 'index'])->middleware('itso.perm:users.read');
            Route::post('users', [UserController::class, 'store'])->middleware('itso.perm:users.write');
            Route::get('users/{id}', [UserController::class, 'show'])->middleware('itso.perm:users.read');
            Route::patch('users/{id}', [UserController::class, 'update'])->middleware('itso.perm:users.write');
            Route::post('users/{id}:lock', [UserController::class, 'lock'])->middleware('itso.perm:users.write');
            Route::post('users/{id}:unlock', [UserController::class, 'unlock'])->middleware('itso.perm:users.write');
            Route::post('users/{id}:reset-mfa', [UserController::class, 'resetMfa'])
                ->middleware(['itso.perm:users.write', 'itso.step-up']);
            Route::post('users/{id}:impersonate', [ImpersonationController::class, 'start'])
                ->middleware(['itso.perm:users.impersonate', 'itso.step-up']);
            Route::get('users/{id}/scopes', [UserController::class, 'scopes'])->middleware('itso.perm:users.read');
            Route::put('users/{id}/scopes', [UserController::class, 'setScopes'])->middleware('itso.perm:users.scopes');
            Route::get('roles', [RoleController::class, 'index'])->middleware('itso.perm:roles.read');

            Route::get('api-tokens', [ApiTokenController::class, 'index'])->middleware('itso.perm:api_tokens.manage');
            Route::post('api-tokens', [ApiTokenController::class, 'store'])
                ->middleware(['itso.perm:api_tokens.manage', 'itso.self']);
            Route::delete('api-tokens/{id}', [ApiTokenController::class, 'destroy'])->middleware('itso.perm:api_tokens.manage');
        });

        // ---- /portal: realm portal (chỉ phiên cookie)
        Route::prefix('portal')->middleware(['itso.auth:portal', 'itso.mfa'])->group(function (): void {
            // Endpoint portal: Prompt 3.5.
        });
    });
});
