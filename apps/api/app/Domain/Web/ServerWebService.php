<?php

declare(strict_types=1);

namespace App\Domain\Web;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Exceptions\ApiProblem;
use App\Models\Job;
use App\Models\PhpVersion;
use App\Models\Server;
use App\Models\ServerSoftware;
use App\Models\Setting;
use App\Models\User;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Web stack theo server (Prompt 5.3): PHP Manager (php.version.install/remove, php.ext.install), Nginx toàn server
 * (nginx.global.apply) và wizard bước 4 (nginx + PHP 8.3 + lego).
 */
final class ServerWebService
{
    public const NGINX_DEFAULTS = ['worker_processes' => 'auto', 'worker_connections' => 1024, 'client_max_body_size' => '64m',
        'gzip' => true, 'http2' => true, 'server_tokens' => false];

    /** Thành phần wizard bước 4: key → [tên, loại cài]. */
    public const STACK = ['nginx' => 'Nginx', 'php8.3' => 'PHP 8.3 (FPM)', 'lego' => 'lego (ACME)'];

    public function __construct(private readonly JobDispatcher $jobs, private readonly AuditLogger $audit) {}

    /** @return list<array<string, mixed>> PhpVersionInfo */
    public function phpVersions(Server $s): array
    {
        $rows = PhpVersion::query()->where('server_id', $s->id)->get()->keyBy('version');
        $versions = array_values(array_unique(array_merge(PhpCatalog::SUPPORTED, $rows->keys()->map(fn ($v): string => (string) $v)->all())));
        sort($versions);
        $out = [];
        foreach ($versions as $v) {
            $r = $rows->get($v);
            $out[] = ['version' => $v, 'installed' => $r instanceof PhpVersion && $r->status === 'ready',
                'default' => $v === PhpCatalog::DEFAULT,
                'sites_count' => Website::query()->where('server_id', $s->id)->where('php_version', $v)->count(),
                'extensions' => $r instanceof PhpVersion ? $r->extensions : []];
        }

        return $out;
    }

    public function managePhp(User $actor, Server $s, string $version, string $action): Job
    {
        if (! PhpCatalog::supported($version)) {
            throw new ApiProblem(409, 'precondition_failed', 'Phiên bản PHP chưa hỗ trợ',
                'Hỗ trợ PHP '.implode(', ', PhpCatalog::SUPPORTED).': 8.3 từ kho Ubuntu, còn lại từ PPA ondrej/php (D-68, D-100).');
        }
        if ($action === 'remove' && Website::query()->where('server_id', $s->id)->where('php_version', $version)->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'PHP đang được dùng', "Còn website dùng PHP $version: chuyển hoặc xóa website trước.");
        }

        return DB::transaction(function () use ($actor, $s, $version, $action): Job {
            $row = $this->phpRow($s, $version);
            $spec = new JobSpec('php.version.'.$action, $s, $s->id, 2, 900);
            $action === 'install'
                ? $spec->step('php.version.install', ['version' => $version, 'extensions' => PhpCatalog::BASE_EXTENSIONS])
                : $spec->step('php.version.remove', ['version' => $version]);
            $job = $this->jobs->dispatch($spec, $actor);
            $row->fill(['status' => $action === 'install' ? 'provisioning' : 'deleting', 'last_job_id' => $job->id,
                'spec_version' => $row->exists ? $row->spec_version + 1 : 1])->save();
            $this->audit->record('php.version.'.$action, $s, ['version' => $version], 'success', $s->id, $job->id, $actor);

            return $job;
        });
    }

    /** @param  list<string>  $exts */
    public function installExtensions(User $actor, Server $s, string $version, array $exts): Job
    {
        if (! PhpCatalog::supported($version)) {
            throw new ApiProblem(409, 'precondition_failed', 'Phiên bản PHP chưa hỗ trợ', 'Phase 5 chỉ có PHP 8.3 (D-68).');
        }
        $exts = array_values(array_unique($exts));
        sort($exts);

        return DB::transaction(function () use ($actor, $s, $version, $exts): Job {
            $row = $this->phpRow($s, $version);
            if ($row->status !== 'ready') {
                throw new ApiProblem(409, 'precondition_failed', 'PHP chưa cài', "Cài PHP $version trước khi thêm extension.");
            }
            $job = $this->jobs->dispatch((new JobSpec('php.extensions.install', $s, $s->id, 2, 900))
                ->step('php.ext.install', ['version' => $version, 'extensions' => $exts]), $actor);
            $row->fill(['status' => 'provisioning', 'last_job_id' => $job->id, 'spec_version' => $row->spec_version + 1])->save();
            $this->audit->record('php.extensions.install', $s, ['version' => $version, 'extensions' => $exts], 'success', $s->id, $job->id, $actor);

            return $job;
        });
    }

    /** @return array<string, mixed> NginxGlobal */
    public function nginx(Server $s): array
    {
        $v = $this->nginxSetting($s)?->value;
        $cfg = array_merge(self::NGINX_DEFAULTS, array_intersect_key(is_array($v) ? $v : [], self::NGINX_DEFAULTS));
        $cfg['updated_at'] = is_string($v['updated_at'] ?? null) ? $v['updated_at'] : $s->created_at->toIso8601String();

        return $cfg;
    }

    /** @param  array<string, mixed>  $cfg */
    public static function nginxEtag(array $cfg): string
    {
        return '"ng-'.substr(hash('sha256', json_encode($cfg, JSON_THROW_ON_ERROR)), 0, 16).'"';
    }

    /** @param  array<string, mixed>  $patch */
    public function updateNginx(User $actor, Server $s, array $patch): Job
    {
        return DB::transaction(function () use ($actor, $s, $patch): Job {
            $old = $this->nginx($s);
            $new = array_merge($old, array_intersect_key($patch, self::NGINX_DEFAULTS));
            if ($new['worker_processes'] !== 'auto' && ((int) $new['worker_processes'] < 1 || (int) $new['worker_processes'] > 256)) {
                throw ApiProblem::field('worker_processes', 'auto hoặc 1–256.');
            }
            unset($new['updated_at'], $old['updated_at']);
            if ($new === $old) {
                throw new ApiProblem(409, 'conflict', 'Không có thay đổi', 'Cấu hình gửi lên giống cấu hình hiện tại.');
            }
            $active = Job::query()->where('server_id', $s->id)->where('type', 'nginx.global.update')
                ->whereIn('state', WebsiteService::ACTIVE_JOB_STATES)->exists();
            if ($active) {
                throw new ApiProblem(409, 'resource_locked', 'Đang có job khác', 'Chờ lần áp cấu hình Nginx trước xong.');
            }
            $job = $this->jobs->dispatch((new JobSpec('nginx.global.update', $s, $s->id, 2, 300))->step('nginx.global.apply', $new), $actor);
            Setting::query()->updateOrCreate(['group_key' => 'nginx', 'key' => 'global:'.$s->uuid],
                ['value' => $new + ['updated_at' => Carbon::now()->toIso8601String()], 'updated_by_user_id' => $actor->id]);
            $changes = [];
            foreach ($new as $k => $v) {
                if ($v !== $old[$k]) {
                    $changes[$k] = ['from' => $old[$k], 'to' => $v];
                }
            }
            $this->audit->record('nginx.global.update', $s, $changes, 'success', $s->id, $job->id, $actor);

            return $job;
        });
    }

    /** @return array<string, mixed> SetupStack */
    public function stack(?Server $s): array
    {
        $components = [];
        $soft = $s !== null ? ServerSoftware::query()->where('server_id', $s->id)->get()->keyBy('software_key') : collect();
        $php = $s !== null ? PhpVersion::query()->where('server_id', $s->id)->where('version', PhpCatalog::DEFAULT)->first() : null;
        foreach (self::STACK as $key => $name) {
            if ($key === 'php8.3') {
                $state = match ($php?->status) {
                    'ready' => 'installed', 'provisioning', 'deleting' => 'installing', 'failed' => 'failed', default => 'available',
                };
                $ver = $state === 'installed' ? (is_string($php?->observed_facts['version'] ?? null) ? $php->observed_facts['version'] : PhpCatalog::DEFAULT) : null;
            } else {
                $r = $soft->get($key);
                $installed = $r instanceof ServerSoftware && is_string($r->version) && $r->version !== '' ? $r->version : null;
                $state = match ($r?->status) {
                    'provisioning', 'deleting' => 'installing', 'failed' => 'failed',
                    'ready' => $installed !== null ? 'installed' : 'available', default => 'available',
                };
                $ver = $state === 'installed' ? $installed : null;
            }
            $components[] = ['key' => $key, 'name' => $name, 'installed_version' => $ver, 'state' => $state];
        }
        $job = $s !== null ? Job::query()->where('server_id', $s->id)->where('type', 'setup.stack')->orderByDesc('id')->first() : null;

        return ['server' => $s !== null ? ['uuid' => $s->uuid, 'name' => $s->name] : null, 'components' => $components,
            'ready' => collect($components)->every(fn (array $c): bool => $c['state'] === 'installed'),
            'job_uuid' => $job !== null && in_array($job->state, WebsiteService::ACTIVE_JOB_STATES, true) ? $job->uuid : null];
    }

    public function installStack(User $actor, Server $s): Job
    {
        $st = $this->stack($s);
        if ($st['job_uuid'] !== null) {
            throw new ApiProblem(409, 'resource_locked', 'Đang cài', 'Job cài web stack đang chạy.');
        }
        $todo = array_values(array_filter($st['components'], fn (array $c): bool => $c['state'] !== 'installed'));
        if ($todo === []) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Đã cài đủ', 'Nginx, PHP 8.3 và lego đã có trên server.');
        }

        return DB::transaction(function () use ($actor, $s, $todo): Job {
            $spec = new JobSpec('setup.stack', $s, $s->id, 2, 1800);
            foreach ($todo as $c) {
                $c['key'] === 'php8.3'
                    ? $spec->step('php.version.install', ['version' => PhpCatalog::DEFAULT, 'extensions' => PhpCatalog::BASE_EXTENSIONS])
                    : $spec->step('software.install', ['recipe' => $c['key']]);
            }
            $job = $this->jobs->dispatch($spec, $actor);
            foreach ($todo as $c) {
                if ($c['key'] === 'php8.3') {
                    $row = $this->phpRow($s, PhpCatalog::DEFAULT);
                    $row->fill(['status' => 'provisioning', 'last_job_id' => $job->id, 'spec_version' => $row->exists ? $row->spec_version + 1 : 1])->save();
                } else {
                    $row = ServerSoftware::query()->firstOrNew(['server_id' => $s->id, 'software_key' => $c['key']]);
                    $row->fill(['status' => 'provisioning', 'last_job_id' => $job->id, 'spec_version' => $row->exists ? $row->spec_version + 1 : 1])->save();
                }
            }
            $this->audit->record('setup.stack', $s, ['components' => array_column($todo, 'key')], 'success', $s->id, $job->id, $actor);

            return $job;
        });
    }

    private function phpRow(Server $s, string $version): PhpVersion
    {
        $row = PhpVersion::query()->where('server_id', $s->id)->where('version', $version)->lockForUpdate()->first()
            ?? new PhpVersion(['server_id' => $s->id, 'version' => $version, 'extensions' => []]);
        if ($row->last_job_id !== null && Job::query()->whereKey($row->last_job_id)->whereIn('state', WebsiteService::ACTIVE_JOB_STATES)->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'Đang có job khác', "PHP $version đang được cài/gỡ.");
        }

        return $row;
    }

    private function nginxSetting(Server $s): ?Setting
    {
        return Setting::query()->where('group_key', 'nginx')->where('key', 'global:'.$s->uuid)->first();
    }
}
