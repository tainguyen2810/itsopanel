<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use App\Domain\Hosting\QuotaService;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\HostingAccount;
use App\Models\Server;
use App\Models\ServerCapacity;
use App\Models\ServerService;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Thu số liệu server qua typed op (metrics.snapshot, service.status), ghi metric_samples, server_services,
 * server_capacity. Gọi bởi `itso:metrics-collect` (scheduler mỗi phút). Không chạy lệnh hệ thống.
 */
final class MetricsCollector
{
    /** Dịch vụ theo dõi: trùng enum ServiceName của agent (contracts/agent-ops/defs.schema.json). */
    public const SERVICES = ['nginx', 'php8.1-fpm', 'php8.2-fpm', 'php8.3-fpm', 'php8.4-fpm', 'mariadb', 'postgresql',
        'redis-server', 'fail2ban', 'cron', 'ssh', 'itso-gateway'];

    /** Giữ metric_samples bao nhiêu ngày (partition theo ngày, DATABASE.md). */
    public const RETENTION_DAYS = 7;

    public function __construct(
        private readonly AgentClient $agent,
        private readonly ServerFacts $facts,
        private readonly QuotaService $quota,
    ) {}

    /** @return array{facts: bool, metrics: bool, services: int} */
    public function collect(Server $server): array
    {
        $out = ['facts' => $this->facts->refresh($server), 'metrics' => false, 'services' => 0];
        $this->capacity($server);
        if (! $out['facts']) {
            return $out;
        }
        $now = Carbon::now();
        try {
            $m = $this->agent->call('metrics.snapshot');
            if ($m->ok && $m->data !== null) {
                $this->storeSnapshot($server->refresh(), $m->data, $now);
                $out['metrics'] = true;
            }
            $out['services'] = $this->services($server);
        } catch (AgentUnavailable) {
            // Agent vừa trả lời system.info: lỗi tạm thời, lần thu sau thử lại.
        }

        return $out;
    }

    /** Hỏi trạng thái các dịch vụ trong allowlist rồi ghi server_services. Trả số dịch vụ đã ghi. */
    public function services(Server $server): int
    {
        $res = $this->agent->call('service.status', ['names' => self::SERVICES]);
        if (! $res->ok || ! is_array($res->data['services'] ?? null)) {
            return 0;
        }
        $now = Carbon::now();
        $n = 0;
        foreach ($res->data['services'] as $svc) {
            if (! is_array($svc) || ! in_array($svc['name'] ?? null, self::SERVICES, true)) {
                continue;
            }
            $row = ServerService::query()->firstOrNew(['server_id' => $server->id, 'name' => $svc['name']]);
            $active = (bool) ($svc['active'] ?? false);
            if ($row->observed_state !== ($active ? 'active' : 'inactive')) {
                $row->observed_at = $now; // "since": lần đầu thấy trạng thái này
            }
            $row->observed_state = $active ? 'active' : 'inactive';
            $row->enabled = (bool) ($svc['enabled'] ?? false);
            $row->save();
            $versions = (array) ($server->observed_facts['service_versions'] ?? []);
            $versions[$svc['name']] = is_string($svc['version'] ?? null) ? $svc['version'] : null;
            $server->forceFill(['observed_facts' => array_merge($server->observed_facts, ['service_versions' => $versions])]);
            $n++;
        }
        $server->save();

        return $n;
    }

    /** Tính lại dung lượng đã cấp từ giới hạn gói của các account chưa purge. */
    public function capacity(Server $server): ServerCapacity
    {
        $f = $server->observed_facts;
        $cap = ServerCapacity::query()->find($server->id) ?? new ServerCapacity(['server_id' => $server->id, 'max_accounts' => 200]);
        $cpu = $ram = $disk = 0;
        $accounts = HostingAccount::query()->where('server_id', $server->id)
            ->whereNotIn('lifecycle_state', ['purged', 'failed'])->get();
        foreach ($accounts as $a) {
            $l = $this->quota->limits($a);
            $cpu += (int) $l['cpu_percent'];
            $ram += (int) $l['ram_mb'];
            $disk += (int) $l['disk_mb'];
        }
        $cap->fill([
            'cpu_cores' => (int) ($f['cpu_cores'] ?? 0), 'ram_mb' => (int) ($f['ram_mb'] ?? 0), 'disk_mb' => (int) ($f['disk_mb'] ?? 0),
            'allocated_cpu_pct' => $cpu, 'allocated_ram_mb' => $ram, 'allocated_disk_mb' => $disk,
            'account_count' => $accounts->count(), 'updated_at' => Carbon::now(),
        ])->save();

        return $cap;
    }

    /** @param  array<string, mixed>  $d  kết quả metrics.snapshot */
    private function storeSnapshot(Server $server, array $d, Carbon $now): void
    {
        $f = $server->observed_facts;
        $ram = (int) ($f['ram_mb'] ?? 0);
        $disk = (int) ($f['disk_mb'] ?? 0);
        $vals = [
            'cpu_pct' => (float) ($d['cpu_pct'] ?? 0),
            'ram_used_mb' => (int) ($d['ram_used_mb'] ?? 0),
            'disk_used_mb' => (int) ($d['disk_used_mb'] ?? 0),
            'load_1m' => (float) ($d['load_1m'] ?? 0),
        ];
        $server->forceFill(['observed_facts' => array_merge($f, $vals)])->save();
        $samples = [
            'cpu_pct' => $vals['cpu_pct'],
            'ram_pct' => $ram > 0 ? round($vals['ram_used_mb'] * 100 / $ram, 2) : 0.0,
            'disk_pct' => $disk > 0 ? round($vals['disk_used_mb'] * 100 / $disk, 2) : 0.0,
            'load_1m' => $vals['load_1m'],
        ];
        $this->insertSamples($server->id, null, $samples, $now);
    }

    /** @param  array<string, float|int>  $samples */
    public function insertSamples(int $serverId, ?int $accountId, array $samples, Carbon $at): void
    {
        $this->ensurePartition($at);
        DB::table('metric_samples')->insert(array_map(fn (string $metric, float|int $v): array => [
            'server_id' => $serverId, 'hosting_account_id' => $accountId, 'metric' => $metric, 'value' => $v, 'at' => $at,
        ], array_keys($samples), array_values($samples)));
    }

    /** @var array<string, true> */
    private array $partitions = [];

    private function ensurePartition(Carbon $at): void
    {
        $day = $at->copy()->utc()->toDateString();
        if (! isset($this->partitions[$day])) {
            DB::select('SELECT itso_ensure_metric_partition(?::date)', [$day]);
            $this->partitions[$day] = true;
        }
    }

    /** Xóa partition metric_samples_YYYYMMDD cũ hơn RETENTION_DAYS và mẫu cũ trong partition default. */
    public function prune(?Carbon $now = null): int
    {
        $cut = ($now ?? Carbon::now())->copy()->utc()->subDays(self::RETENTION_DAYS)->format('Ymd');
        $dropped = 0;
        $parts = DB::select("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
            JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'metric_samples'");
        foreach ($parts as $r) {
            $name = (string) $r->relname;
            if (preg_match('/^metric_samples_(\d{8})$/', $name, $m) === 1 && $m[1] < $cut) {
                DB::statement('DROP TABLE IF EXISTS "'.$name.'"'); // tên đã khớp regex chặt, không lấy từ input
                $dropped++;
            }
        }
        DB::table('metric_samples_default')->where('at', '<', Carbon::createFromFormat('Ymd', $cut, 'UTC')?->startOfDay())->delete();

        return $dropped;
    }
}
