<?php

use App\Http\Controllers\Api\V1\Admin\ApiTokenController;
use App\Http\Controllers\Api\V1\Admin\AuditLogController;
use App\Http\Controllers\Api\V1\Admin\DashboardController;
use App\Http\Controllers\Api\V1\Admin\DnsController;
use App\Http\Controllers\Api\V1\Admin\HostingAccountController;
use App\Http\Controllers\Api\V1\Admin\HostingPackageController;
use App\Http\Controllers\Api\V1\Admin\ImpersonationController;
use App\Http\Controllers\Api\V1\Admin\RoleController;
use App\Http\Controllers\Api\V1\Admin\ServerController;
use App\Http\Controllers\Api\V1\Admin\ServerOpsController;
use App\Http\Controllers\Api\V1\Admin\ServerWebController;
use App\Http\Controllers\Api\V1\Admin\SettingsController;
use App\Http\Controllers\Api\V1\Admin\SetupController;
use App\Http\Controllers\Api\V1\Admin\UserController;
use App\Http\Controllers\Api\V1\Auth\AuthController;
use App\Http\Controllers\Api\V1\Auth\MfaController;
use App\Http\Controllers\Api\V1\Auth\PasswordController;
use App\Http\Controllers\Api\V1\Auth\SessionController;
use App\Http\Controllers\Api\V1\JobController;
use App\Http\Controllers\Api\V1\NotificationController;
use App\Http\Controllers\Api\V1\Portal\PortalController;
use App\Http\Controllers\Api\V1\Shared\CertificateController;
use App\Http\Controllers\Api\V1\Shared\WebsiteController;
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

        // ---- /admin/setup: wizard cài đặt lần đầu (4.5). Bước 0–2 công khai (cần phiên đã xác minh mã),
        // bước 3+ cần SA do wizard tạo đã bật TOTP. Sau khi khóa: 410.
        Route::prefix('admin/setup')->group(function (): void {
            Route::get('status', [SetupController::class, 'status']);
            Route::post('code:verify', [SetupController::class, 'verifyCode']);
            Route::put('preferences', [SetupController::class, 'preferences']);
            Route::post('admin', [SetupController::class, 'createAdmin']);
            Route::middleware(['itso.auth:admin', 'itso.mfa'])->group(function (): void {
                Route::put('access', [SetupController::class, 'access']);
                Route::get('quota', [SetupController::class, 'quota']);
                Route::get('stack', [SetupController::class, 'stack']);
            });
        });
        Route::post('admin/setup:complete', [SetupController::class, 'complete'])
            ->middleware(['itso.auth:admin', 'itso.mfa']);
        Route::post('admin/setup/stack:install', [SetupController::class, 'installStack'])
            ->middleware(['itso.auth:admin', 'itso.mfa', 'itso.idempotent']);

        // ---- /admin: realm admin (phiên cookie hoặc API token)
        Route::prefix('admin')->middleware(['itso.auth:admin', 'itso.mfa'])->group(function (): void {
            Route::prefix('system')->middleware('itso.scope:system:read')->group(function (): void {
                Route::get('version', [SystemController::class, 'version']);
                Route::get('status', [SystemController::class, 'status']);
                Route::get('updates', [SystemController::class, 'updates'])->middleware('itso.perm:settings.read');
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

            // Job, audit, thông báo, cài đặt, server, dashboard (3.4)
            Route::get('dashboard/summary', [DashboardController::class, 'summary']);
            Route::get('jobs', [JobController::class, 'index'])->middleware('itso.perm:jobs.read');
            Route::get('jobs/{id}', [JobController::class, 'show'])->middleware('itso.perm:jobs.read');
            Route::get('jobs/{id}/events', [JobController::class, 'events'])->middleware('itso.perm:jobs.read');
            Route::get('jobs/{id}/logs', [JobController::class, 'logs'])->middleware('itso.perm:jobs.read');
            Route::post('jobs/{id}:cancel', [JobController::class, 'cancel'])->middleware('itso.perm:jobs.write');
            Route::post('jobs/{id}:retry', [JobController::class, 'retry'])->middleware(['itso.perm:jobs.write', 'itso.idempotent']);
            Route::get('audit-logs', [AuditLogController::class, 'index'])->middleware('itso.perm:audit.read');
            Route::get('audit-logs/export', [AuditLogController::class, 'export'])->middleware('itso.perm:audit.export');
            Route::get('notifications', [NotificationController::class, 'index']);
            Route::post('notifications/{id}:read', [NotificationController::class, 'read']);
            Route::post('notifications:read-all', [NotificationController::class, 'readAll']);
            Route::get('settings/{group}', [SettingsController::class, 'show'])->middleware('itso.perm:settings.read');
            Route::patch('settings/{group}', [SettingsController::class, 'update'])
                ->middleware(['itso.perm:settings.write', 'itso.step-up']);
            Route::get('servers', [ServerController::class, 'index'])->middleware('itso.perm:servers.read');
            Route::get('servers/{id}', [ServerController::class, 'show'])->middleware('itso.perm:servers.read');
            Route::patch('servers/{id}', [ServerController::class, 'update'])->middleware('itso.perm:servers.write');

            // Dịch vụ, phần mềm, reboot, dung lượng, số liệu (4.5) — thao tác chạm Linux đi qua Job
            Route::get('servers/{id}/capacity', [ServerOpsController::class, 'capacity'])->middleware('itso.perm:servers.read');
            Route::get('servers/{id}/services', [ServerOpsController::class, 'services'])->middleware('itso.perm:servers.read');
            Route::post('servers/{id}/services/{service}:{action}', [ServerOpsController::class, 'controlService'])
                ->middleware(['itso.perm:servers.write', 'itso.idempotent']);
            Route::post('servers/{id}:reboot', [ServerOpsController::class, 'reboot'])
                ->middleware(['itso.perm:servers.write', 'itso.step-up', 'itso.idempotent']);
            Route::get('servers/{id}/software', [ServerOpsController::class, 'software'])->middleware('itso.perm:servers.read');
            Route::post('servers/{id}/software/{key}:{action}', [ServerOpsController::class, 'manageSoftware'])
                ->middleware(['itso.perm:software.write', 'itso.idempotent']);
            Route::get('servers/{id}/php-versions', [ServerWebController::class, 'phpVersions'])->middleware('itso.perm:servers.read');
            Route::post('servers/{id}/php-versions/{version}/extensions', [ServerWebController::class, 'installExtensions'])
                ->middleware(['itso.perm:software.write', 'itso.idempotent']);
            Route::post('servers/{id}/php-versions/{version}:{action}', [ServerWebController::class, 'managePhp'])
                ->middleware(['itso.perm:software.write', 'itso.idempotent']);
            Route::get('servers/{id}/nginx', [ServerWebController::class, 'nginx'])->middleware('itso.perm:servers.read');
            Route::patch('servers/{id}/nginx', [ServerWebController::class, 'updateNginx'])
                ->middleware(['itso.perm:servers.write', 'itso.idempotent']);
            Route::get('metrics/servers/{id}', [ServerOpsController::class, 'serverMetrics'])->middleware('itso.perm:servers.read');
            Route::get('metrics/hosting-accounts/{id}', [ServerOpsController::class, 'accountMetrics'])->middleware('itso.perm:accounts.read');

            // Gói, account hosting (3.5)
            Route::get('hosting-packages', [HostingPackageController::class, 'index'])->middleware('itso.perm:packages.read');
            Route::post('hosting-packages', [HostingPackageController::class, 'store'])->middleware('itso.perm:packages.write');
            Route::get('hosting-packages/{id}', [HostingPackageController::class, 'show'])->middleware('itso.perm:packages.read');
            Route::patch('hosting-packages/{id}', [HostingPackageController::class, 'update'])->middleware('itso.perm:packages.write');
            Route::delete('hosting-packages/{id}', [HostingPackageController::class, 'destroy'])->middleware('itso.perm:packages.write');
            Route::get('hosting-packages/{id}/versions', [HostingPackageController::class, 'versions'])->middleware('itso.perm:packages.read');
            Route::post('hosting-packages/{id}/versions/{version}:migrate-accounts', [HostingPackageController::class, 'migrateAccounts'])
                ->middleware(['itso.perm:packages.write', 'itso.idempotent']);
            Route::get('placement/suggestions', [HostingAccountController::class, 'placement'])->middleware('itso.perm:accounts.write');

            Route::get('hosting-accounts', [HostingAccountController::class, 'index'])->middleware('itso.perm:accounts.read');
            Route::post('hosting-accounts', [HostingAccountController::class, 'store'])->middleware(['itso.perm:accounts.write', 'itso.idempotent']);
            Route::get('hosting-accounts/{id}', [HostingAccountController::class, 'show'])->middleware('itso.perm:accounts.read');
            Route::patch('hosting-accounts/{id}', [HostingAccountController::class, 'update'])->middleware('itso.perm:accounts.write');
            Route::get('hosting-accounts/{id}/features', [HostingAccountController::class, 'features'])->middleware('itso.perm:accounts.read');
            Route::get('hosting-accounts/{id}/usage', [HostingAccountController::class, 'usage'])->middleware('itso.perm:accounts.read');
            Route::get('hosting-accounts/{id}/lifecycle-events', [HostingAccountController::class, 'lifecycleEvents'])
                ->middleware('itso.perm:accounts.read');
            foreach (['suspend', 'unsuspend', 'change-package'] as $action) {
                Route::post("hosting-accounts/{id}:$action", [HostingAccountController::class, lcfirst(str_replace('-', '', ucwords($action, '-')))])
                    ->middleware(['itso.perm:accounts.write', 'itso.idempotent']);
            }
            Route::post('hosting-accounts/{id}:terminate', [HostingAccountController::class, 'terminate'])
                ->middleware(['itso.perm:accounts.terminate', 'itso.step-up', 'itso.idempotent']);
            foreach (['migrate', 'schedule-purge', 'confirm-purge'] as $action) {
                Route::post("hosting-accounts/{id}:$action", [HostingAccountController::class, 'notAvailable'])
                    ->middleware(['itso.perm:accounts.terminate', 'itso.step-up']);
            }

            // ---- Website (Prompt 5.3); quét mã độc/WAF thuộc Phase 7, chưa có route.
            Route::get('websites', [WebsiteController::class, 'index'])->middleware('itso.perm:websites.read');
            Route::post('websites', [WebsiteController::class, 'store'])->middleware(['itso.perm:websites.write', 'itso.idempotent']);
            Route::get('websites/{id}', [WebsiteController::class, 'show'])->middleware('itso.perm:websites.read');
            Route::patch('websites/{id}', [WebsiteController::class, 'update'])->middleware(['itso.perm:websites.write', 'itso.idempotent']);
            Route::delete('websites/{id}', [WebsiteController::class, 'destroy'])->middleware(['itso.perm:websites.write', 'itso.step-up', 'itso.idempotent']);
            Route::get('websites/{id}/domains', [WebsiteController::class, 'domains'])->middleware('itso.perm:websites.read');
            Route::post('websites/{id}/domains', [WebsiteController::class, 'addDomain'])->middleware(['itso.perm:websites.write', 'itso.idempotent']);
            Route::delete('websites/{id}/domains/{domain}', [WebsiteController::class, 'removeDomain'])->middleware(['itso.perm:websites.write', 'itso.idempotent']);
            Route::get('websites/{id}/nginx', [WebsiteController::class, 'nginx'])->middleware('itso.perm:websites.read');
            Route::patch('websites/{id}/nginx', [WebsiteController::class, 'updateNginx'])->middleware(['itso.perm:websites.write', 'itso.idempotent']);
            Route::get('websites/{id}/php', [WebsiteController::class, 'php'])->middleware('itso.perm:websites.read');
            Route::patch('websites/{id}/php', [WebsiteController::class, 'updatePhp'])->middleware(['itso.perm:websites.write', 'itso.idempotent']);
            Route::get('websites/{id}/logs', [WebsiteController::class, 'logs'])->middleware('itso.perm:websites.read');
            // ---- Chứng chỉ (Prompt 5.4)
            Route::get('certificates', [CertificateController::class, 'index'])->middleware('itso.perm:websites.read');
            Route::post('certificates/{id}:renew', [CertificateController::class, 'renew'])->middleware(['itso.perm:websites.write', 'itso.idempotent']);
            Route::delete('certificates/{id}', [CertificateController::class, 'destroy'])->middleware(['itso.perm:websites.write', 'itso.idempotent']);
            Route::post('websites/{id}/certificates', [CertificateController::class, 'store'])->middleware(['itso.perm:websites.write', 'itso.idempotent']);
            // ---- DNS Cloudflare (Prompt 5.4, D-70)
            Route::get('dns/providers', [DnsController::class, 'providers'])->middleware('itso.perm:dns.read');
            Route::post('dns/providers', [DnsController::class, 'storeProvider'])->middleware('itso.perm:dns.providers');
            Route::delete('dns/providers/{id}', [DnsController::class, 'destroyProvider'])->middleware(['itso.perm:dns.providers', 'itso.step-up']);
            Route::get('dns/zones', [DnsController::class, 'zones'])->middleware('itso.perm:dns.read');
            Route::post('dns/zones', [DnsController::class, 'storeZone'])->middleware('itso.perm:dns.write');
            Route::patch('dns/zones/{id}', [DnsController::class, 'updateZone'])->middleware('itso.perm:dns.write');
            Route::delete('dns/zones/{id}', [DnsController::class, 'destroyZone'])->middleware('itso.perm:dns.write');
            Route::post('dns/zones/{id}:sync', [DnsController::class, 'sync'])->middleware('itso.perm:dns.write');
            Route::get('dns/zones/{id}/records', [DnsController::class, 'records'])->middleware('itso.perm:dns.read');
            Route::post('dns/zones/{id}/records', [DnsController::class, 'storeRecord'])->middleware(['itso.perm:dns.write', 'itso.idempotent']);
            Route::patch('dns/zones/{id}/records/{record}', [DnsController::class, 'updateRecord'])->middleware(['itso.perm:dns.write', 'itso.idempotent']);
            Route::delete('dns/zones/{id}/records/{record}', [DnsController::class, 'destroyRecord'])->middleware(['itso.perm:dns.write', 'itso.idempotent']);
        });

        // ---- /portal: realm portal (chỉ phiên cookie)
        Route::prefix('portal')->middleware(['itso.auth:portal', 'itso.mfa'])->group(function (): void {
            Route::get('jobs', [JobController::class, 'index']);
            Route::get('jobs/{id}', [JobController::class, 'show']);
            Route::get('jobs/{id}/events', [JobController::class, 'events']);
            Route::get('jobs/{id}/logs', [JobController::class, 'logs']);
            Route::post('jobs/{id}:cancel', [JobController::class, 'cancel']);
            Route::post('jobs/{id}:retry', [JobController::class, 'retry'])->middleware('itso.idempotent');
            Route::get('notifications', [NotificationController::class, 'index']);
            Route::post('notifications/{id}:read', [NotificationController::class, 'read']);
            Route::post('notifications:read-all', [NotificationController::class, 'readAll']);
            Route::get('overview', [PortalController::class, 'overview']);
            Route::get('profile', [PortalController::class, 'profile']);
            Route::patch('profile', [PortalController::class, 'updateProfile']);
            Route::get('hosting-accounts', [PortalController::class, 'accounts']);
            Route::get('hosting-accounts/{id}', [PortalController::class, 'account']);
            Route::get('hosting-accounts/{id}/features', [PortalController::class, 'features']);
            Route::get('hosting-accounts/{id}/usage', [PortalController::class, 'usage']);

            // ---- Website (Prompt 5.3); quét mã độc/WAF thuộc Phase 7, chưa có route.
            Route::get('websites', [WebsiteController::class, 'index']);
            Route::post('websites', [WebsiteController::class, 'store'])->middleware(['itso.idempotent']);
            Route::get('websites/{id}', [WebsiteController::class, 'show']);
            Route::patch('websites/{id}', [WebsiteController::class, 'update'])->middleware(['itso.idempotent']);
            Route::delete('websites/{id}', [WebsiteController::class, 'destroy'])->middleware(['itso.step-up', 'itso.idempotent']);
            Route::get('websites/{id}/domains', [WebsiteController::class, 'domains']);
            Route::post('websites/{id}/domains', [WebsiteController::class, 'addDomain'])->middleware(['itso.idempotent']);
            Route::delete('websites/{id}/domains/{domain}', [WebsiteController::class, 'removeDomain'])->middleware(['itso.idempotent']);
            Route::get('websites/{id}/nginx', [WebsiteController::class, 'nginx']);
            Route::patch('websites/{id}/nginx', [WebsiteController::class, 'updateNginx'])->middleware(['itso.idempotent']);
            Route::get('websites/{id}/php', [WebsiteController::class, 'php']);
            Route::patch('websites/{id}/php', [WebsiteController::class, 'updatePhp'])->middleware(['itso.idempotent']);
            Route::get('websites/{id}/logs', [WebsiteController::class, 'logs']);
            // ---- Chứng chỉ (Prompt 5.4)
            Route::get('certificates', [CertificateController::class, 'index']);
            Route::post('certificates/{id}:renew', [CertificateController::class, 'renew'])->middleware(['itso.idempotent']);
            Route::delete('certificates/{id}', [CertificateController::class, 'destroy'])->middleware(['itso.idempotent']);
            Route::post('websites/{id}/certificates', [CertificateController::class, 'store'])->middleware(['itso.idempotent']);
        });
    });
});
