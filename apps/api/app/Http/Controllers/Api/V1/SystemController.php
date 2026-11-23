<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Carbon;
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
            'repair_command' => 'sudo itso repair --fix',
            'releases' => $releases,
            'journal' => self::journal(),
            'history' => self::history(),
        ]);
    }

    private const JOURNAL_STEPS = ['downloaded', 'verified', 'extracted', 'migrated', 'switched', 'restarted'];

    /**
     * Lượt update đang dở (D-113): agent ghi /var/lib/itso/update.journal, panel chỉ đọc. Journal cũ hơn 15 phút coi là
     * bị ngắt (máy tắt, kill) → gợi ý `itso repair --fix`.
     *
     * @return array{version_to: string, step: string, started_at: string, interrupted: bool, hint: string}|null
     */
    private static function journal(): ?array
    {
        $j = self::readJson(rtrim((string) config('itso.update_state_dir'), '/').'/update.journal');
        if (! is_array($j) || ! is_string($j['version_to'] ?? null) || ! in_array($j['step'] ?? null, self::JOURNAL_STEPS, true)
            || ! is_string($j['started_at'] ?? null)) {
            return null;
        }
        $started = Carbon::parse($j['started_at']);
        $interrupted = $started->lt(now()->subMinutes(15));
        $before = array_search($j['step'], self::JOURNAL_STEPS, true) < array_search('migrated', self::JOURNAL_STEPS, true);

        return ['version_to' => mb_substr($j['version_to'], 0, 64), 'step' => $j['step'], 'started_at' => $started->toIso8601String(),
            'interrupted' => $interrupted,
            'hint' => ! $interrupted ? 'Đang cập nhật, chờ lệnh itso update chạy xong.'
                : ($before ? 'Cập nhật bị ngắt trước bước migrate: sudo itso repair --fix dọn bản dở, bản đang chạy giữ nguyên.'
                    : 'Cập nhật bị ngắt sau migrate: sudo itso repair --fix hoàn tất hoặc quay về bản cũ.')];
    }

    /**
     * 20 lượt update/rollback/repair gần nhất từ update-history.jsonl (mới nhất trước); dòng sai định dạng bị bỏ.
     *
     * @return list<array<string, mixed>>
     */
    private static function history(): array
    {
        $file = rtrim((string) config('itso.update_state_dir'), '/').'/update-history.jsonl';
        if (! is_file($file) || ! is_readable($file) || filesize($file) > 1048576) {
            return [];
        }
        $out = [];
        foreach (array_reverse(file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: []) as $line) {
            $e = json_decode($line, true);
            if (! is_array($e) || ! in_array($e['action'] ?? null, ['update', 'rollback', 'repair'], true)
                || ! in_array($e['result'] ?? null, ['succeeded', 'rolled_back', 'failed', 'interrupted'], true)
                || ! is_string($e['started_at'] ?? null)) {
                continue;
            }
            $fin = is_string($e['finished_at'] ?? null) ? Carbon::parse($e['finished_at'])->toIso8601String() : null;
            $out[] = ['action' => $e['action'], 'version_from' => mb_substr((string) ($e['version_from'] ?? ''), 0, 64),
                'version_to' => mb_substr((string) ($e['version_to'] ?? ''), 0, 64), 'result' => $e['result'],
                'started_at' => Carbon::parse($e['started_at'])->toIso8601String(), 'finished_at' => $fin,
                'duration_sec' => is_int($e['duration_sec'] ?? null) && $e['duration_sec'] >= 0 ? $e['duration_sec'] : null,
                'by' => mb_substr((string) ($e['by'] ?? 'cli'), 0, 64),
                'note' => is_string($e['note'] ?? null) ? mb_substr($e['note'], 0, 500) : null];
            if (count($out) === 20) {
                break;
            }
        }

        return $out;
    }

    private static function readJson(string $file): mixed
    {
        if (! is_file($file) || ! is_readable($file) || filesize($file) > 65536) {
            return null;
        }

        return json_decode((string) file_get_contents($file), true);
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
