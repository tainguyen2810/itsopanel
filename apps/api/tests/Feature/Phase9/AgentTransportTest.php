<?php

use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobRunner;
use App\Domain\Jobs\JobSpec;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Infrastructure\Agent\AgentUnreachable;
use App\Models\Agent;
use App\Models\Server;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;

// Prompt 9.2: AgentClient chọn kênh theo agents.transport (local → socket agent; mtls → itso-relay, khóa riêng node).

function p9result(string $opId): array
{
    return ['v' => 1, 'op_id' => $opId, 'ok' => true, 'data' => ['pong' => true], 'error' => null,
        'duration_ms' => 1, 'agent_version' => '0.9.0', 'cached' => false];
}

function p9node(string $key, string $transport = 'mtls'): Server
{
    $s = Server::factory()->create();
    $a = Agent::query()->create(['server_id' => $s->id, 'transport' => $transport, 'connection' => 'online']);
    DB::table('agents')->where('id', $a->id)->update(['hmac_key_encrypted' => AgentClient::encryptKey($key)]);

    return $s;
}

beforeEach(function () {
    config(['itso.agent.socket' => null, 'itso.agent.url' => 'http://agent.test', 'itso.agent.key_file' => null,
        'itso.relay.socket' => '/tmp/itso-test-relay.sock']);
    app()->forgetInstance(AgentClient::class);
});

it('server local hoặc không có agent → socket agent cục bộ /v1/ops', function () {
    Http::fake(['agent.test/v1/ops' => fn (Request $r) => Http::response(p9result(json_decode($r->body(), true)['op_id']))]);
    $local = p9node(str_repeat('l', 40), 'local');
    $res = app(AgentClient::class)->forServer($local->id)->call('system.ping');
    expect($res->ok)->toBeTrue();
    expect(app(AgentClient::class)->forServer(null)->call('system.ping')->ok)->toBeTrue();
    Http::assertSentCount(2);
});

it('server mtls → relay /v1/nodes/{uuid}/ops, ký bằng khóa riêng node trên đường /v1/ops', function () {
    $key = str_repeat('k', 48);
    $node = p9node($key);
    Http::fake(['relay/v1/nodes/*' => fn (Request $r) => Http::response(p9result(json_decode($r->body(), true)['op_id']))]);
    $res = app(AgentClient::class)->forServer($node->id)->call('system.ping');
    expect($res->ok)->toBeTrue();
    Http::assertSent(function (Request $r) use ($key, $node) {
        $ts = (int) $r->header('X-ITSO-Timestamp')[0];
        $nonce = $r->header('X-ITSO-Nonce')[0];

        return $r->url() === 'http://relay/v1/nodes/'.$node->uuid.'/ops'
            && $r->header('X-ITSO-Signature')[0] === AgentClient::signature($key, 'POST', '/v1/ops', $ts, $nonce, $r->body());
    });
    // Khóa lưu mã hóa, không phải bản rõ.
    $raw = DB::table('agents')->where('server_id', $node->id)->value('hmac_key_encrypted');
    $raw = is_resource($raw) ? stream_get_contents($raw) : $raw;
    expect($raw)->not->toContain($key);
});

it('relay trả 503 agent_unreachable → AgentUnreachable; node bị thu hồi → AgentUnavailable', function () {
    $node = p9node(str_repeat('k', 48));
    Http::fake(['relay/*' => Http::response(['code' => 'agent_unreachable'], 503)]);
    expect(fn () => app(AgentClient::class)->forServer($node->id)->call('system.ping'))->toThrow(AgentUnreachable::class);
    Agent::query()->where('server_id', $node->id)->update(['connection' => 'revoked', 'revoked_at' => now()]);
    expect(fn () => app(AgentClient::class)->forServer($node->id))->toThrow(AgentUnavailable::class, 'thu hồi');
});

it('node chưa có khóa HMAC → AgentUnavailable', function () {
    $s = Server::factory()->create();
    Agent::query()->create(['server_id' => $s->id, 'transport' => 'mtls', 'connection' => 'pending']);
    expect(fn () => app(AgentClient::class)->forServer($s->id))->toThrow(AgentUnavailable::class, 'khóa HMAC');
});

it('JobRunner gửi bước của job tới đúng node qua relay; node mất kết nối → job chờ node (waiting_agent) có hạn', function () {
    $node = p9node(str_repeat('k', 48));
    $calls = 0;
    Http::fake(['relay/v1/nodes/*' => function (Request $r) use (&$calls) {
        $calls++;

        return Http::response(['code' => 'agent_unreachable'], 503);
    }]);
    Queue::fake();
    $job = app(JobDispatcher::class)->dispatch((new JobSpec('system.ping', null, $node->id, 1, 60))->step('system.ping', []), null);
    app(JobRunner::class)->run($job->id);
    $job->refresh();
    expect($calls)->toBe(1)->and($job->state)->toBe('waiting_agent')->and($job->agent_deadline_at)->not->toBeNull();
});
