<?php

use Illuminate\Support\Facades\Http;
use Tests\Support\OpenApi;

function assertMatchesContract(string $file, string $method, string $path, int $status, $response): void
{
    ['schema' => $schema, 'contentType' => $ct, 'file' => $ctx] = OpenApi::responseSchema($file, $method, $path, $status);
    expect($response->status())->toBe($status)
        ->and($response->headers->get('Content-Type'))->toStartWith($ct);
    $error = OpenApi::validate($ctx, $schema, $response->json());
    expect($error)->toBeNull();
}

it('GET /api/v1/system/health khớp schema getHealth (admin và portal)', function () {
    $res = $this->getJson('/api/v1/system/health');
    $res->assertOk()->assertExactJson(['data' => ['status' => 'ok']]);
    assertMatchesContract('itso-admin-v1.yaml', 'get', '/api/v1/system/health', 200, $res);
    assertMatchesContract('itso-portal-v1.yaml', 'get', '/api/v1/system/health', 200, $res);
    expect($res->headers->get('X-Request-Id'))->toMatch('/^req_[0-9A-Z]{26}$/');
});

it('GET /api/v1/admin/system/version khớp schema getSystemVersion', function () {
    $res = $this->getJson('/api/v1/admin/system/version');
    assertMatchesContract('itso-admin-v1.yaml', 'get', '/api/v1/admin/system/version', 200, $res);
    expect($res->json('data.version'))->toBe('0.1.0-alpha');
});

it('GET /api/v1/admin/system/status: agent mock trả pong → reachable, khớp schema', function () {
    Http::fake(['*/v1/ops' => function ($request) {
        $env = $request->data();
        expect($env['op'])->toBe('system.ping')
            ->and($env['v'])->toBe(1)
            ->and($env['op_id'])->toMatch('/^[0-9a-f-]{36}:1:1$/')
            ->and($env['requested_by'])->toBe(['user_uuid' => null, 'role' => 'SYSTEM']);

        return Http::response(['v' => 1, 'op_id' => $env['op_id'], 'ok' => true,
            'data' => ['pong' => true, 'agent_version' => '0.1.0-mock', 'mode' => 'mock'],
            'error' => null, 'duration_ms' => 0, 'agent_version' => '0.1.0-mock']);
    }]);
    config(['itso.agent.socket' => null, 'itso.agent.url' => 'http://127.0.0.1:7810']);

    $res = $this->getJson('/api/v1/admin/system/status');
    assertMatchesContract('itso-admin-v1.yaml', 'get', '/api/v1/admin/system/status', 200, $res);
    expect($res->json('data.agent'))->toMatchArray(['reachable' => true, 'mode' => 'mock', 'version' => '0.1.0-mock'])
        ->and($res->json('data.database.ok'))->toBeTrue();
});

it('GET /api/v1/admin/system/status: agent không chạy → reachable=false, api=degraded', function () {
    $res = $this->getJson('/api/v1/admin/system/status');
    assertMatchesContract('itso-admin-v1.yaml', 'get', '/api/v1/admin/system/status', 200, $res);
    expect($res->json('data.agent.reachable'))->toBeFalse()
        ->and($res->json('data.api'))->toBe('degraded')
        ->and($res->json('data.agent.error'))->toContain('AgentUnavailable');
});

it('route không tồn tại trả 404 application/problem+json đúng schema Problem', function () {
    $res = $this->getJson('/api/v1/khong-ton-tai');
    $res->assertNotFound();
    expect($res->headers->get('Content-Type'))->toBe('application/problem+json')
        ->and($res->json())->toMatchArray([
            'type' => 'https://docs.itso.local/errors/not_found', 'status' => 404, 'code' => 'not_found',
            'instance' => '/api/v1/khong-ton-tai',
        ]);
    expect(OpenApi::validate('common.yaml', ['$ref' => '#/components/schemas/Problem'], $res->json()))->toBeNull();
});

it('sai phương thức trả 405 problem+json kèm Allow', function () {
    $res = $this->postJson('/api/v1/system/health');
    $res->assertStatus(405);
    expect($res->headers->get('Content-Type'))->toBe('application/problem+json')
        ->and($res->headers->get('Allow'))->toContain('GET')
        ->and($res->json('code'))->toBe('bad_request')
        ->and(OpenApi::validate('common.yaml', ['$ref' => '#/components/schemas/Problem'], $res->json()))->toBeNull();
});

it('lỗi không lường trước trả 500 problem+json, không lộ chi tiết khi APP_DEBUG=false', function () {
    config(['app.debug' => false]);
    Route::get('/api/v1/__boom', fn () => throw new RuntimeException('bí mật nội bộ'));
    $res = $this->getJson('/api/v1/__boom');
    $res->assertStatus(500);
    expect($res->headers->get('Content-Type'))->toBe('application/problem+json')
        ->and($res->json('code'))->toBe('internal_error')
        ->and($res->getContent())->not->toContain('bí mật');
});

it('route admin/system không đăng ký ngoài local/testing', function () {
    $routes = file_get_contents(base_path('routes/api.php'));
    expect($routes)->toContain("app()->environment(config('itso.dev_routes_envs'))")
        ->and(config('itso.dev_routes_envs'))->toBe(['local', 'testing']);
});

it('bộ kiểm contract bắt được dữ liệu sai (tự kiểm helper)', function () {
    ['schema' => $schema, 'file' => $ctx] = OpenApi::responseSchema('itso-admin-v1.yaml', 'get', '/api/v1/system/health', 200);
    expect(OpenApi::validate($ctx, $schema, ['data' => ['status' => 'down']]))->not->toBeNull()
        ->and(OpenApi::validate('common.yaml', ['$ref' => '#/components/schemas/Problem'], ['title' => 'x']))->not->toBeNull();
});

it('mặc định không bật CORS (web gọi API cùng origin)', function () {
    $res = $this->getJson('/api/v1/system/health', ['Origin' => 'https://evil.example']);
    expect($res->headers->has('Access-Control-Allow-Origin'))->toBeFalse();
});
