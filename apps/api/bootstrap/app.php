<?php

use App\Http\Middleware\AssignRequestId;
use App\Support\ProblemRenderer;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->prepend(AssignRequestId::class);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Mọi lỗi dưới /api/* trả RFC 9457 application/problem+json.
        $exceptions->render(function (Throwable $e, Request $request) {
            return $request->is('api', 'api/*') ? ProblemRenderer::render($e) : null;
        });
    })->create();
