<?php

use App\Exceptions\ApiProblem;
use App\Http\Middleware\ApplyRememberPreference;
use App\Http\Middleware\AssignRequestId;
use App\Http\Middleware\AuditDenied;
use App\Http\Middleware\Authenticate;
use App\Http\Middleware\EnsureIpAllowed;
use App\Http\Middleware\Idempotency;
use App\Http\Middleware\LimitRequestBody;
use App\Http\Middleware\RejectImpersonation;
use App\Http\Middleware\RequireMfa;
use App\Http\Middleware\RequirePermission;
use App\Http\Middleware\RequireStepUp;
use App\Http\Middleware\RequireTokenScope;
use App\Http\Middleware\ResolveRealm;
use App\Http\Middleware\SecurityHeaders;
use App\Http\Middleware\VerifyCsrf;
use App\Support\ProblemRenderer;
use Illuminate\Cookie\Middleware\AddQueuedCookiesToResponse;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Session\Middleware\StartSession;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->prepend(AssignRequestId::class);
        // ASVS L2 (Prompt 12.4): header bảo mật + giới hạn kích thước body cho mọi yêu cầu.
        $middleware->append(SecurityHeaders::class);
        $middleware->append(LimitRequestBody::class);
        // API SPA cùng origin (D-58): phiên cookie theo realm + CSRF double-submit.
        $middleware->group('itso.web', [
            ResolveRealm::class,
            EncryptCookies::class,
            AddQueuedCookiesToResponse::class,
            StartSession::class,
            ApplyRememberPreference::class,
            VerifyCsrf::class,
            EnsureIpAllowed::class,
            AuditDenied::class,
        ]);
        // ResolveRealm đặt tên cookie phiên nên phải chạy trước EncryptCookies/StartSession (sắp xếp theo priority).
        $middleware->prependToPriorityList(EncryptCookies::class, ResolveRealm::class);
        $middleware->alias([
            'itso.auth' => Authenticate::class,
            'itso.mfa' => RequireMfa::class,
            'itso.step-up' => RequireStepUp::class,
            'itso.scope' => RequireTokenScope::class,
            'itso.perm' => RequirePermission::class,
            'itso.self' => RejectImpersonation::class,
            'itso.idempotent' => Idempotency::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Lỗi 4xx có chủ đích (chưa đăng nhập, dữ liệu sai, 409…) là phản hồi bình thường, không ghi log lỗi.
        $exceptions->dontReportWhen(fn (Throwable $e): bool => $e instanceof ApiProblem && $e->status < 500);
        // Mọi lỗi dưới /api/* trả RFC 9457 application/problem+json.
        $exceptions->render(function (Throwable $e, Request $request) {
            return $request->is('api', 'api/*') ? ProblemRenderer::render($e) : null;
        });
    })->create();
