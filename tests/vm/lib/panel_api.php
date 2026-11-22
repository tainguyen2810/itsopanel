<?php

/*
 * Gọi API Admin của panel TRONG TIẾN TRÌNH (artisan tinker) cho bộ test VM Phase 9 — chỉ dùng trên VM test dùng một lần.
 *
 * Khớp route → controller rồi gọi thẳng action với user = Super Admin đầu tiên: BỎ QUA middleware (phiên, MFA step-up,
 * idempotency) vì script chạy bằng root trên control plane và cần lặp lại không có người. Validate, phạm vi, nghiệp vụ,
 * audit và job vẫn đi đúng đường như khi gọi qua HTTP.
 *
 *   VM_METHOD=POST VM_PATH=/api/v1/admin/... VM_BODY='{"a":1}' artisan tinker --execute "require '<file>'; vm_api_main();"
 *
 * In một dòng JSON: {"status": <http>, "body": <json>}.
 */

use App\Models\User;
use Illuminate\Contracts\Debug\ExceptionHandler;
use Illuminate\Http\Request;

function vm_api(string $method, string $path, array $body = []): array
{
    $sa = User::query()->where('realm', 'admin')->where('status', 'active')->orderBy('id')->firstOrFail();
    $get = $method === 'GET';
    $req = Request::create($path, $method, $get ? $body : [], [], [],
        ['HTTP_ACCEPT' => 'application/json', 'CONTENT_TYPE' => 'application/json', 'REMOTE_ADDR' => '127.0.0.1'],
        $get ? null : json_encode($body, JSON_THROW_ON_ERROR));
    app()->instance('request', $req); // rebinding đặt lại user resolver: đặt user SAU dòng này
    auth()->setUser($sa);
    $req->setUserResolver(fn () => $sa);
    try {
        $route = app('router')->getRoutes()->match($req);
        $route->bind($req);
        $req->setRouteResolver(fn () => $route);
        $res = app()->call([$route->getController(), $route->getActionMethod()], array_merge(['request' => $req], $route->parameters()));
    } catch (Throwable $e) {
        $res = app(ExceptionHandler::class)->render($req, $e);
    }

    return ['status' => $res->getStatusCode(), 'body' => json_decode((string) $res->getContent(), true)];
}

function vm_api_main(): void
{
    $body = json_decode((string) getenv('VM_BODY') ?: '{}', true) ?? [];
    echo "\n@@".json_encode(vm_api((string) getenv('VM_METHOD'), (string) getenv('VM_PATH'), $body), JSON_UNESCAPED_UNICODE)."\n";
}
