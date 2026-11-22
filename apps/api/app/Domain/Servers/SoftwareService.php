<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\Job;
use App\Models\Server;
use App\Models\ServerService;
use App\Models\ServerSoftware;
use App\Models\SoftwareCatalog;
use App\Models\User;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Software Manager (D-100, ADR 0045): catalog từ agent, cài/gỡ/nâng cấp qua job, chặn xung đột, thiếu phụ thuộc,
 * gỡ thành phần lõi hoặc đang dùng. Agent kiểm lại các ràng buộc này (không tin panel).
 */
final class SoftwareService
{
    public function __construct(private readonly JobDispatcher $jobs, private readonly AuditLogger $audit,
        private readonly AgentClient $agent) {}

    /** @return array<string, ServerSoftware> */
    public function rows(Server $s): array
    {
        return ServerSoftware::query()->where('server_id', $s->id)->get()->keyBy('software_key')->all();
    }

    private static function installed(?ServerSoftware $r): bool
    {
        return $r !== null && $r->status === 'ready' && is_string($r->version) && $r->version !== '';
    }

    /**
     * Mức độ đang dùng của recipe trên server (kind → số lượng), từ dữ liệu panel.
     *
     * @return list<array{kind: string, count: int}>
     */
    public function usage(Server $s, string $key): array
    {
        $out = [];
        if (preg_match('/^php(\d\.\d)$/', $key, $m) === 1) {
            $n = Website::query()->where('server_id', $s->id)->where('php_version', $m[1])->count();
            if ($n > 0) {
                $out[] = ['kind' => 'website', 'count' => $n];
                $out[] = ['kind' => 'php_pool', 'count' => $n];
            }
        }
        if ($key === 'nginx') {
            $n = Website::query()->where('server_id', $s->id)->count();
            if ($n > 0) {
                $out[] = ['kind' => 'website', 'count' => $n];
            }
        }
        if ($key === 'docker') {
            $n = DB::table('compose_projects')->where('server_id', $s->id)->whereNull('deleted_at')->count();
            if ($n > 0) {
                $out[] = ['kind' => 'compose_project', 'count' => $n];
            }
        }
        if ($key === 'wp-cli') {
            $n = DB::table('wordpress_sites')->join('websites', 'websites.id', '=', 'wordpress_sites.website_id')
                ->where('websites.server_id', $s->id)->whereNull('wordpress_sites.deleted_at')->count();
            if ($n > 0) {
                $out[] = ['kind' => 'wordpress_site', 'count' => $n];
            }
        }

        return $out;
    }

    /**
     * Lý do không gỡ được (null = gỡ được).
     *
     * @param  array<string, ServerSoftware>  $rows
     */
    public function removeBlocked(Server $s, SoftwareCatalog $c, array $rows): ?string
    {
        if ($c->core) {
            return 'Thành phần lõi của panel, không gỡ được';
        }
        foreach ($this->usage($s, $c->key) as $u) {
            if ($u['kind'] !== 'php_pool') {
                return match ($u['kind']) {
                    'website' => "Đang có {$u['count']} website dùng",
                    'compose_project' => "Đang có {$u['count']} compose project",
                    'wordpress_site' => "WordPress Toolkit đang quản lý {$u['count']} site",
                    default => 'Đang được dùng',
                };
            }
        }
        foreach (SoftwareCatalog::query()->get() as $o) {
            if (in_array($c->key, $o->requires, true) && self::installed($rows[$o->key] ?? null)) {
                return "{$o->name} phụ thuộc phần mềm này";
            }
        }

        return null;
    }

    /**
     * @param  array<string, ServerSoftware>  $rows
     * @return array<string, mixed> Software (OpenAPI)
     */
    public function present(Server $s, SoftwareCatalog $c, ?ServerSoftware $row, array $rows): array
    {
        $installed = self::installed($row) ? $row?->version : null;
        $latest = $row->latest_version ?? (is_string($c->versions[0] ?? null) ? $c->versions[0] : 'apt');
        $state = match ($row?->status) {
            'provisioning', 'deleting' => 'installing',
            'failed' => 'failed',
            'ready' => $installed === null ? 'available' : ($row->upgrade_available ? 'upgradable' : 'installed'),
            default => 'available',
        };
        $service = null;
        if ($c->service !== null && $installed !== null) {
            $st = ServerService::query()->where('server_id', $s->id)->where('name', $c->service)->value('observed_state');
            $service = ['name' => $c->service, 'active' => $st === 'active'];
        }

        return ['key' => $c->key, 'name' => $c->name, 'category' => $c->category, 'installed_version' => $installed,
            'latest_version' => $latest, 'state' => $state, 'source' => $c->source, 'service' => $service,
            'core' => $c->core, 'conflicts' => $c->conflicts, 'requires' => $c->requires,
            'in_use' => array_values(array_filter($this->usage($s, $c->key), fn (array $u): bool => $u['count'] > 0)),
            'remove_blocked' => $installed !== null ? $this->removeBlocked($s, $c, $rows) : null];
    }

    public function manage(User $actor, Server $s, SoftwareCatalog $c, string $action): Job
    {
        if (! in_array($action, ['install', 'remove', 'upgrade'], true)) {
            throw ApiProblem::field('action', 'Hành động không hợp lệ.');
        }
        $key = $c->key;
        $rows = $this->rows($s);
        $row = $rows[$key] ?? null;
        if ($action === 'install') {
            if (self::installed($row)) {
                throw new ApiProblem(409, 'conflict', 'Đã cài', "{$c->name} đã cài trên server này.");
            }
            foreach ($c->conflicts as $other) {
                if (self::installed($rows[$other] ?? null)) {
                    throw new ApiProblem(409, 'conflict', 'Xung đột phần mềm', "{$c->name} xung đột với {$other} đang cài: gỡ {$other} trước.");
                }
            }
            foreach ($c->requires as $need) {
                if (! self::installed($rows[$need] ?? null)) {
                    throw new ApiProblem(422, 'validation_failed', 'Thiếu phụ thuộc', "Cần cài {$need} trước {$c->name}.",
                        ['key' => ["Cần cài {$need} trước."]]);
                }
            }
        } else {
            if (! self::installed($row)) {
                throw new ApiProblem(409, 'invalid_state_transition', 'Chưa cài', "{$c->name} chưa cài trên server này.");
            }
            if ($action === 'remove' && ($why = $this->removeBlocked($s, $c, $rows)) !== null) {
                throw new ApiProblem(409, 'resource_locked', 'Không gỡ được', $why);
            }
        }

        return DB::transaction(function () use ($actor, $s, $key, $action, $c): Job {
            $row = ServerSoftware::query()->where('server_id', $s->id)->where('software_key', $key)->lockForUpdate()->first()
                ?? new ServerSoftware(['server_id' => $s->id, 'software_key' => $key]);
            if (in_array($row->status, ['provisioning', 'deleting'], true)) {
                throw new ApiProblem(409, 'resource_locked', 'Đang có job khác', "Phần mềm {$key} đang được cài/gỡ.");
            }
            $spec = (new JobSpec('software.'.$action, $s, $s->id, maxAttempts: 2, timeoutSec: 900))
                ->step('software.'.$action, ['recipe' => $key]);
            $job = $this->jobs->dispatch($spec, $actor);
            $row->status = $action === 'remove' ? 'deleting' : 'provisioning';
            $row->state = match ($action) {
                'install' => 'installing', 'remove' => 'removing', default => 'upgrading',
            };
            $row->spec_version = $row->exists ? $row->spec_version + 1 : 1;
            $row->last_job_id = $job->id;
            $row->save();
            $this->audit->record('software.'.$action, $s, ['key' => $key, 'name' => $c->name], 'success', $s->id, $job->id, $actor);

            return $job;
        });
    }

    /**
     * Đồng bộ catalog (software.catalog) và trạng thái (software.status) từ agent. Agent không trả lời → giữ dữ liệu cũ.
     *
     * @return array{catalog: int, status: int}
     */
    public function refresh(Server $s): array
    {
        $n = ['catalog' => 0, 'status' => 0];
        try {
            $cat = $this->agent->forServer($s->id)->call('software.catalog', [], null, null, 30.0);
            if ($cat->ok) {
                foreach ((array) ($cat->data['recipes'] ?? []) as $r) {
                    if (! is_array($r) || ! is_string($r['recipe'] ?? null)) {
                        continue;
                    }
                    $c = SoftwareCatalog::query()->firstOrNew(['key' => $r['recipe']]);
                    $c->fill(['name' => (string) $r['name'], 'category' => (string) $r['category'],
                        'source' => (string) $r['source'], 'service' => is_string($r['service'] ?? null) ? $r['service'] : null,
                        'core' => (bool) $r['core'], 'conflicts' => array_values(array_map('strval', (array) $r['conflicts'])),
                        'requires' => array_values(array_map('strval', (array) $r['requires'])),
                        'packages' => array_values(array_map('strval', (array) $r['packages']))]);
                    if (! $c->exists) {
                        $c->versions = [];
                    }
                    $c->save();
                    $n['catalog']++;
                }
            }
            $st = $this->agent->forServer($s->id)->call('software.status', ['recipes' => []], null, null, 120.0);
            if ($st->ok) {
                foreach ((array) ($st->data['software'] ?? []) as $r) {
                    if (! is_array($r) || ! is_string($r['recipe'] ?? null)) {
                        continue;
                    }
                    $row = ServerSoftware::query()->firstOrNew(['server_id' => $s->id, 'software_key' => $r['recipe']]);
                    if (in_array($row->status, ['provisioning', 'deleting'], true)) {
                        continue; // job đang chạy sẽ ghi kết quả
                    }
                    $ver = is_string($r['installed_version'] ?? null) ? $r['installed_version'] : null;
                    $latest = is_string($r['latest_version'] ?? null) ? $r['latest_version'] : null;
                    if (! $row->exists && $ver === null) {
                        continue;
                    }
                    $up = $ver !== null && $latest !== null && $latest !== $ver;
                    $row->fill(['version' => $ver, 'latest_version' => $latest, 'upgrade_available' => $up,
                        'status' => 'ready', 'state' => $ver === null ? 'available' : ($up ? 'upgradable' : 'installed'),
                        'observed_at' => Carbon::now()]);
                    if (! $row->exists) {
                        $row->spec_version = 1;
                    }
                    $row->save();
                    $n['status']++;
                }
                $os = OsUpdates::get($s);
                $os['pending_security'] = (int) ($st->data['pending_security'] ?? 0);
                OsUpdates::put($s, $os);
            }
        } catch (AgentUnavailable) {
            // giữ dữ liệu cũ
        }

        return $n;
    }
}
