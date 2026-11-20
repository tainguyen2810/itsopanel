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
