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

    /** Phiên bản hiện tại + các release còn giữ trong /opt/itso/releases (chỉ đọc tên thư mục, không chạy lệnh). */
    public function updates(): JsonResponse
    {
        $dir = (string) config('itso.releases_dir');
        $link = (string) config('itso.current_link');
        $active = is_link($link) ? basename((string) readlink($link)) : null;
        $releases = [];
        if (is_dir($dir)) {
            foreach (scandir($dir) ?: [] as $name) {
                if (preg_match('/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/', $name) === 1 && is_file("$dir/$name/.complete")) {
                    $releases[] = ['version' => $name, 'active' => $name === $active];
                }
            }
        }
        usort($releases, fn (array $a, array $b): int => version_compare($b['version'], $a['version']));
        $channel = (string) config('itso.update_channel');

        return self::data([
            'current_version' => (string) config('itso.version'),
            'commit' => (string) config('itso.commit'),
            'channel' => in_array($channel, ['stable', 'beta'], true) ? $channel : 'stable',
            'latest_version' => null,
            'update_available' => false,
            'checked_at' => null,
            'update_command' => 'sudo itso update --release-dir <thư mục release đã tải>',
            'releases' => $releases,
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
