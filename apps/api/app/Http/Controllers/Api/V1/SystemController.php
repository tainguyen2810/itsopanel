<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Redis;
use Throwable;

/**
 * GET /api/v1/system/health          (getHealth, public)
 * GET /api/v1/admin/system/version   (getSystemVersion)
 * GET /api/v1/admin/system/status    (getSystemStatus)
 */
final class SystemController
{
    public function health(): JsonResponse
    {
        return self::data(['status' => 'ok']);
    }

    public function version(): JsonResponse
    {
        return self::data([
            'version' => (string) config('itso.version'),
            'commit' => (string) config('itso.commit'),
            'agent_min_version' => (string) config('itso.agent_min_version'),
            'update_available' => null,
        ]);
    }

    public function status(AgentClient $agent): JsonResponse
    {
        $database = self::probe(static fn () => DB::connection()->select('select 1'));
        $redis = self::probe(static fn () => Redis::connection()->ping());
        $agentStatus = self::agent($agent);
        $healthy = $database['ok'] && $redis['ok'] && $agentStatus['reachable'];

        return self::data([
            'api' => $healthy ? 'ok' : 'degraded',
            'database' => $database,
            'redis' => $redis,
            'agent' => $agentStatus,
            'checked_at' => now()->toIso8601String(),
        ]);
    }

    /**
     * @param  callable(): mixed  $fn
     * @return array{ok: bool, latency_ms: float|null, error: string|null}
     */
    private static function probe(callable $fn): array
    {
        $t = hrtime(true);
        try {
            $fn();

            return ['ok' => true, 'latency_ms' => self::ms($t), 'error' => null];
        } catch (Throwable $e) {
            return ['ok' => false, 'latency_ms' => null, 'error' => self::short($e)];
        }
    }

    /**
     * @return array{reachable: bool, mode: string|null, version: string|null, latency_ms: float|null, error: string|null}
     */
    private static function agent(AgentClient $agent): array
    {
        $t = hrtime(true);
        try {
            $res = $agent->call('system.ping');
        } catch (AgentUnavailable $e) {
            return ['reachable' => false, 'mode' => null, 'version' => null, 'latency_ms' => null, 'error' => self::short($e)];
        }
        if (! $res->ok) {
            return ['reachable' => false, 'mode' => null, 'version' => $res->agentVersion, 'latency_ms' => self::ms($t),
                'error' => $res->error['code'] ?? 'agent_error'];
        }
        $mode = $res->data['mode'] ?? null;

        return [
            'reachable' => true,
            'mode' => in_array($mode, ['mock', 'real'], true) ? $mode : null,
            'version' => $res->agentVersion,
            'latency_ms' => self::ms($t),
            'error' => null,
        ];
    }

    private static function ms(int|float $start): float
    {
        return round((hrtime(true) - $start) / 1e6, 1);
    }

    private static function short(Throwable $e): string
    {
        return mb_substr(class_basename($e).': '.$e->getMessage(), 0, 200);
    }

    /** @param  array<string, mixed>  $data */
    private static function data(array $data): JsonResponse
    {
        return new JsonResponse(['data' => $data], 200, [], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
}
