<?php

use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use Illuminate\Http\Client\Factory;

it('ném AgentUnavailable khi không cấu hình socket/url', function () {
    (new AgentClient(new Factory, null, null))->call('system.ping');
})->throws(AgentUnavailable::class);

it('ném AgentUnavailable khi agent trả dữ liệu sai giao thức', function () {
    $http = new Factory;
    $http->fake(['*' => $http->response('<html>', 200)]);
    (new AgentClient($http, null, 'http://127.0.0.1:7810'))->call('system.ping');
})->throws(AgentUnavailable::class);

it('đọc kết quả lỗi của agent', function () {
    $http = new Factory;
    $http->fake(['*' => $http->response(['v' => 1, 'op_id' => 'x', 'ok' => false, 'data' => null,
        'error' => ['code' => 'op_disabled', 'message' => 'm', 'retryable' => false], 'duration_ms' => 1, 'agent_version' => '0.1.0-mock'])]);
    $res = (new AgentClient($http, null, 'http://127.0.0.1:7810'))->call('system.reboot', ['delay_sec' => 0, 'reason' => 't']);
    expect($res->ok)->toBeFalse()->and($res->error['code'])->toBe('op_disabled');
});

// Vector dùng chung với agent Go (agent/internal/auth/auth_test.go TestCrossLanguageVector).
it('chữ ký HMAC khớp vector dùng chung với agent Go', function () {
    expect(AgentClient::signature(str_repeat('k', 32), 'POST', '/v1/ops', 1700000000, 'abcdefghijklmnop', '{"a":1}'))
        ->toBe('f5255c6bdc5f11677842af5e7327e438f5803f57bd6c5c91a99e753d022b472d');
});

it('ký request bằng khóa trong ITSO_AGENT_KEY_FILE: header khớp đúng body đã gửi', function () {
    $key = tempnam(sys_get_temp_dir(), 'itso-key');
    file_put_contents($key, str_repeat('s', 48)."\n");
    $http = new Factory;
    $http->fake(['*' => $http->response(['v' => 1, 'op_id' => 'x', 'ok' => true, 'data' => ['pong' => true],
        'error' => null, 'duration_ms' => 1, 'agent_version' => '0.4.0'])]);
    (new AgentClient($http, null, 'http://127.0.0.1:7810', 5.0, $key))->call('system.ping');
    $http->assertSent(function ($r) {
        $ts = (int) $r->header('X-ITSO-Timestamp')[0];
        $nonce = $r->header('X-ITSO-Nonce')[0];

        return abs($ts - time()) < 5 && json_decode($r->body(), true)['nonce'] === $nonce
            && $r->header('X-ITSO-Signature')[0] === AgentClient::signature(str_repeat('s', 48), 'POST', '/v1/ops', $ts, $nonce, $r->body());
    });
    // Khóa quá ngắn → không gửi, báo agent không dùng được.
    file_put_contents($key, 'short');
    expect(fn () => (new AgentClient($http, null, 'http://127.0.0.1:7810', 5.0, $key))->call('system.ping'))
        ->toThrow(AgentUnavailable::class);
    unlink($key);
});
