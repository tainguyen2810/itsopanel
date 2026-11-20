<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Infrastructure\Agent\AgentClient;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;

/**
 * Agent giả qua Http::fake: trả lời theo op. Handler nhận envelope, trả `data` (mảng) hoặc
 * `['__error' => [code, message, retryable]]`. Ghi lại các envelope đã nhận.
 */
final class FakeAgent
{
    /** @var list<array<string, mixed>> */
    public array $calls = [];

    /** @param  array<string, callable(array<string, mixed>): array<string, mixed>>  $handlers */
    public function __construct(private array $handlers = [])
    {
        config(['itso.agent.socket' => null, 'itso.agent.url' => 'http://agent.test']);
        app()->forgetInstance(AgentClient::class);
        Http::fake(['agent.test/v1/ops' => function (Request $r) {
            /** @var array<string, mixed> $env */
            $env = $r->data();
            $this->calls[] = $env;
            $h = $this->handlers[$env['op']] ?? $this->handlers['*'] ?? fn (): array => [];
            $out = $h($env);
            $err = $out['__error'] ?? null;

            return Http::response([
                'v' => 1, 'op_id' => $env['op_id'], 'ok' => $err === null,
                'data' => $err === null ? $out : null,
                'error' => $err === null ? null : ['code' => $err[0], 'message' => $err[1], 'retryable' => $err[2] ?? false],
                'duration_ms' => 1, 'agent_version' => '0.1.0-mock', 'cached' => false,
            ]);
        }]);
    }

    public function on(string $op, callable $handler): self
    {
        $this->handlers[$op] = $handler;

        return $this;
    }

    /** @return list<string> */
    public function ops(): array
    {
        return array_map(fn (array $c): string => (string) $c['op'], $this->calls);
    }
}
