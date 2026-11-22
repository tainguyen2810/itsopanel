<?php

declare(strict_types=1);

namespace App\Domain\Docker;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Domain\Jobs\Secrets;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\ComposeProject;
use App\Models\ComposeRevision;
use App\Models\DockerContainer;
use App\Models\ImageRollback;
use App\Models\Job;
use App\Models\PortAllocation;
use App\Models\Registry;
use App\Models\Server;
use App\Models\User;
use App\Models\Website;
use Illuminate\Database\QueryException;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Compose project (D-96, D-97, ADR 0041/0042): mọi YAML qua compose.validate của agent trước khi lưu thành revision
 * chạy được; cổng host cấp trong transaction (unique server+port+protocol, thử lại khi đụng nhau); override chỉ
 * SUPER_ADMIN kèm lý do; biến môi trường lưu Crypt và tới agent qua tham chiếu bí mật `compose_env:<uuid>`.
 */
final class ComposeService
{
    public const OVERRIDABLE = ['privileged', 'cap_add', 'devices', 'bind_mount'];

    private const MAX_ATTEMPTS = 3;

    public function __construct(private readonly AgentClient $agent, private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit, private readonly DockerHostService $hosts) {}

    /** @return array{mem_limit_mb: int, cpus: float, pids_limit: int} */
    public static function limits(): array
    {
        return ['mem_limit_mb' => max(16, (int) config('itso.docker.default_mem_limit_mb', 512)),
            'cpus' => max(0.05, (float) config('itso.docker.default_cpus', 1.0)),
            'pids_limit' => max(16, (int) config('itso.docker.default_pids_limit', 512))];
    }

    /** Uuid cố định cho bản xem trước trên một server (agent ghi sha đã kiểm vào một thư mục duy nhất). */
    public static function previewUuid(Server $s): string
    {
        $h = md5('itso-compose-preview:'.$s->uuid);

        return substr($h, 0, 8).'-'.substr($h, 8, 4).'-4'.substr($h, 13, 3).'-8'.substr($h, 17, 3).'-'.substr($h, 20, 12);
    }

    /**
     * Chuẩn hóa override: chỉ SUPER_ADMIN (ADMIN gửi → 403), rule trong danh sách cho phép, lý do 10–300 ký tự.
     *
     * @return list<array{rule: string, reason: string, by_user_uuid: string, at: string}>
     */
    public static function overrides(User $actor, mixed $raw): array
    {
        $raw = is_array($raw) ? array_values($raw) : [];
        if ($raw === []) {
            return [];
        }
        if ($actor->roleKey() !== 'SUPER_ADMIN') {
            throw ApiProblem::forbidden('Chỉ Super Admin được override kết quả validator (D-96).');
        }
        $out = [];
        foreach ($raw as $i => $o) {
            $rule = is_array($o) ? ($o['rule'] ?? null) : null;
            $reason = is_array($o) ? trim((string) ($o['reason'] ?? '')) : '';
            if (! is_string($rule) || ! in_array($rule, self::OVERRIDABLE, true)) {
                throw ApiProblem::field("overrides.$i.rule", 'Rule không override được (chỉ: '.implode(', ', self::OVERRIDABLE).').');
            }
            if (mb_strlen($reason) < 10 || mb_strlen($reason) > 300) {
                throw ApiProblem::field("overrides.$i.reason", 'Lý do override cần 10–300 ký tự.');
            }
            $out[$rule] = ['rule' => $rule, 'reason' => $reason, 'by_user_uuid' => $actor->uuid, 'at' => Carbon::now()->toIso8601String()];
        }

        return array_values($out);
    }

    /**
     * @return array<string, string>
     */
    public static function env(mixed $env): array
    {
        if ($env === null) {
            return [];
        }
        if (! is_array($env) || count($env) > 200) {
            throw ApiProblem::field('env', 'env là object tối đa 200 biến.');
        }
        $out = [];
        foreach ($env as $k => $v) {
            if (! is_string($k) || preg_match('/^[A-Z_][A-Z0-9_]{0,63}$/', $k) !== 1 || str_starts_with($k, 'COMPOSE_') || str_starts_with($k, 'DOCKER_')) {
                throw ApiProblem::field('env', "Tên biến không hợp lệ: $k (A-Z, 0-9, _; không dùng COMPOSE_*/DOCKER_*).");
            }
            if (! is_string($v) || strlen($v) > 4096 || preg_match('/[\r\n\x00\']/', $v) === 1) {
                throw ApiProblem::field('env', "Giá trị biến $k không hợp lệ (một dòng, tối đa 4096 byte, không có dấu ').");
            }
            $out[$k] = $v;
        }
        ksort($out);

        return $out;
    }

    /**
     * Gọi compose.validate (đồng bộ, đọc). Cổng ứng viên = cổng project đang giữ + cổng trống của server.
     *
     * @param  list<array<string, mixed>>  $overrides  ComposeOverride (+ at)
     * @param  list<int>|null  $exactPorts
     * @return array<string, mixed> kết quả compose.validate
     */
    public function validate(Server $s, string $uuid, string $name, string $yaml, array $overrides, ?ComposeProject $p = null,
        ?array $exactPorts = null): array
    {
        $ports = $exactPorts ?? $this->candidatePorts($s, $p);
        $params = ['project' => ['project_uuid' => $uuid, 'name' => $name], 'compose_yaml' => $yaml,
            'allocated_ports' => $ports, 'defaults' => self::limits(),
            'overrides' => array_map(fn (array $o): array => ['rule' => $o['rule'], 'reason' => $o['reason'],
                'by_user_uuid' => $o['by_user_uuid']], $overrides),
            'allow_home_bind' => false];
        try {
            $r = $this->agent->forServer($s->id)->call('compose.validate', $params, null, null, 30.0);
        } catch (AgentUnavailable $e) {
            throw new ApiProblem(503, 'agent_unavailable', 'Agent không trả lời', mb_substr($e->getMessage(), 0, 200));
        }
        if (! $r->ok || $r->data === null) {
            $code = (string) ($r->error['code'] ?? 'internal');
            $msg = mb_substr((string) ($r->error['message'] ?? $code), 0, 300);
            if ($code === 'invalid_params') {
                throw ApiProblem::field('compose_yaml', $msg);
            }
            throw new ApiProblem(409, 'precondition_failed', 'Không kiểm được YAML trên server', $msg);
        }

        return $r->data;
    }

    /** @return list<int> */
    private function candidatePorts(Server $s, ?ComposeProject $p): array
    {
        $h = $this->hosts->host($s);
        $from = max(20000, $h->port_range_from);
        $to = min(29999, $h->port_range_to);
        $own = $p !== null ? PortAllocation::query()->where('compose_project_id', $p->id)->orderBy('port')->pluck('port')->map(fn ($x): int => (int) $x)->all() : [];
        $taken = array_flip(PortAllocation::query()->where('server_id', $s->id)->pluck('port')->map(fn ($x): int => (int) $x)->all());
        $out = $own;
        for ($port = $from; $port <= $to && count($out) < min(200, count($own) + 40); $port++) {
            if (! isset($taken[$port])) {
                $out[] = $port;
            }
        }

        return array_values(array_unique($out));
    }

    /**
     * @param  array<string, mixed>  $res
     * @return list<array<string, mixed>>
     */
    private static function portMaps(array $res): array
    {
        return array_values(array_filter((array) ($res['ports'] ?? []), 'is_array'));
    }

    /**
     * Ghi cổng thật sự dùng (theo kết quả validator) cho project, trong transaction đang mở. Cổng đã có người khác
     * giữ → PortConflict để thử lại với ứng viên mới.
     *
     * @param  list<array<string, mixed>>  $ports  ComposePortMap
     */
    private function allocate(ComposeProject $p, array $ports): void
    {
        $want = [];
        foreach ($ports as $pm) {
            $want[$pm['host_port'].'/'.$pm['protocol']] = $pm;
        }
        $cur = PortAllocation::query()->where('compose_project_id', $p->id)->get();
        foreach ($cur as $a) {
            $k = $a->port.'/'.$a->protocol;
            if (! isset($want[$k])) {
                $a->delete();
            } else {
                $a->fill(['service' => $want[$k]['service'], 'container_port' => (int) $want[$k]['container_port']])->save();
                unset($want[$k]);
            }
        }
        foreach ($want as $pm) {
            try {
                DB::transaction(fn () => PortAllocation::query()->create(['server_id' => $p->server_id, 'port' => (int) $pm['host_port'],
                    'protocol' => (string) $pm['protocol'], 'compose_project_id' => $p->id, 'service' => (string) $pm['service'],
                    'container_port' => (int) $pm['container_port']]));
            } catch (QueryException $e) {
                if (($e->errorInfo[0] ?? '') === '23505' || str_contains($e->getMessage(), 'UNIQUE')) {
                    throw new PortConflict((int) $pm['host_port']);
                }
                throw $e;
            }
        }
    }

    /**
     * Lỗi validator → 422 (errors.compose_yaml = các lỗi chặn).
     *
     * @param  array<string, mixed>  $res
     */
    private static function rejected(array $res): ApiProblem
    {
        $errs = [];
        foreach ((array) ($res['findings'] ?? []) as $f) {
            if (is_array($f) && ($f['severity'] ?? '') === 'error') {
                $errs[] = '['.($f['rule'] ?? '?').'] '.(is_string($f['service'] ?? null) ? $f['service'].': ' : '').($f['message'] ?? '');
            }
        }

        return new ApiProblem(422, 'validation_failed', 'YAML bị validator chặn',
            'Compose không qua kiểm tra an toàn: '.count($errs).' lỗi. Sửa YAML (hoặc Super Admin override kèm lý do).',
            ['compose_yaml' => array_slice($errs ?: ['Validator từ chối YAML.'], 0, 50)]);
    }

    /**
     * @param  array<string, mixed>  $res
     * @param  list<array<string, mixed>>  $overrides
     */
    private function revision(ComposeProject $p, string $yaml, array $res, array $overrides, User $actor): ComposeRevision
    {
        $n = (int) ComposeRevision::query()->where('project_id', $p->id)->max('number') + 1;
        $ok = ($res['ok'] ?? false) === true && is_string($res['validated_yaml'] ?? null) && is_string($res['validated_sha256'] ?? null);

        return ComposeRevision::query()->create(['project_id' => $p->id, 'number' => $n, 'yaml' => $yaml,
            'validated_yaml' => $ok ? $res['validated_yaml'] : null, 'validated_sha256' => $ok ? $res['validated_sha256'] : null,
            'ok' => $ok, 'findings_count' => count((array) ($res['findings'] ?? [])),
            'validation_report' => ['findings' => array_values((array) ($res['findings'] ?? [])),
                'rewrites' => array_values((array) ($res['rewrites'] ?? [])), 'ports' => array_values((array) ($res['ports'] ?? [])),
                'images' => array_values((array) ($res['images'] ?? [])), 'volumes' => array_values((array) ($res['volumes'] ?? []))],
            'overrides' => $overrides, 'created_by_user_id' => $actor->id]);
    }

    /**
     * @param  array<string, mixed>  $in  ComposeProjectInput đã validate cú pháp
     * @return array{0: ComposeProject, 1: Job}
     */
    public function create(User $actor, Server $s, array $in): array
    {
        $overrides = self::overrides($actor, $in['overrides'] ?? []);
        $this->hosts->requireEnabled($s);
        $name = (string) $in['name'];
        if (ComposeProject::withTrashed()->where('server_id', $s->id)->where('name', $name)->exists()) {
            throw ApiProblem::conflict("Server đã có compose project tên $name.");
        }
        $env = self::env($in['env'] ?? null);
        $template = isset($in['template']) && is_string($in['template']) ? $in['template'] : null;
        if ($template !== null && ComposeTemplates::find($template) === null) {
            throw ApiProblem::field('template', 'Mẫu không tồn tại.');
        }
        $yaml = (string) $in['compose_yaml'];
        $uuid = (string) Str::uuid();
        for ($attempt = 1; $attempt <= self::MAX_ATTEMPTS; $attempt++) {
            $res = $this->validate($s, $uuid, $name, $yaml, $overrides);
            if (($res['ok'] ?? false) !== true) {
                $this->audit->record('compose.validate_rejected', $s, ['name' => $name, 'findings' => count((array) ($res['findings'] ?? []))],
                    'failure', $s->id, null, $actor);
                throw self::rejected($res);
            }
            try {
                return DB::transaction(function () use ($actor, $s, $uuid, $name, $yaml, $res, $overrides, $env, $template): array {
                    $p = new ComposeProject;
                    $p->forceFill(['uuid' => $uuid, 'server_id' => $s->id, 'name' => $name, 'run_state' => 'deploying',
                        'template' => $template, 'env_encrypted' => $env === [] ? null : Crypt::encryptString((string) json_encode($env)),
                        'created_by_user_id' => $actor->id, 'status' => 'provisioning', 'spec_version' => 1])->save();
                    $this->allocate($p, self::portMaps($res));
                    $rev = $this->revision($p, $yaml, $res, $overrides, $actor);
                    $p->forceFill(['current_revision_id' => $rev->id])->save();
                    $job = $this->jobs->dispatch($this->applySpec('compose.create', $p, $rev), $actor);
                    $this->audit->record('compose.create', $p, ['name' => $name, 'revision' => 1, 'template' => $template,
                        'ports' => array_map(fn ($x) => $x['host_port'] ?? null, (array) ($res['ports'] ?? [])),
                        'overrides' => array_map(fn (array $o): array => ['rule' => $o['rule'], 'reason' => $o['reason']], $overrides),
                        'env_keys' => array_keys($env)], 'success', $s->id, $job->id, $actor);

                    return [$p->refresh(), $job];
                });
            } catch (PortConflict) {
                continue; // project khác vừa giữ cổng này: kiểm lại với ứng viên mới
            }
        }
        throw ApiProblem::conflict('Không cấp được cổng host (đụng nhau liên tục). Thử lại sau.');
    }

    /** @param array<string, mixed> $in  ComposeProjectInput (một phần) */
    public function update(User $actor, ComposeProject $p, array $in): Job
    {
        $s = $p->server;
        $this->hosts->requireEnabled($s);
        $this->ensureIdle($p);
        if (isset($in['name']) && $in['name'] !== $p->name) {
            throw ApiProblem::field('name', 'Không đổi được tên compose project.');
        }
        if (isset($in['server_uuid']) && $in['server_uuid'] !== $s->uuid) {
            throw ApiProblem::field('server_uuid', 'Không chuyển được compose project sang server khác.');
        }
        $cur = $p->currentRevision;
        $yaml = isset($in['compose_yaml']) ? (string) $in['compose_yaml'] : (string) $cur?->yaml;
        $yamlChanged = $cur === null || $yaml !== $cur->yaml;
        if (array_key_exists('overrides', $in)) {
            $overrides = self::overrides($actor, $in['overrides']);
        } else {
            // ADMIN sửa YAML thì override cũ (do Super Admin duyệt cho YAML trước) không tự áp sang YAML mới.
            $keep = ! $yamlChanged || $actor->roleKey() === 'SUPER_ADMIN';
            $overrides = $keep && $cur !== null ? $cur->overrides : [];
        }
        $env = array_key_exists('env', $in) ? self::env($in['env']) : null;
        $template = array_key_exists('template', $in) ? (is_string($in['template']) ? $in['template'] : null) : $p->template;
        if ($template !== null && $template !== $p->template && ComposeTemplates::find($template) === null) {
            throw ApiProblem::field('template', 'Mẫu không tồn tại.');
        }
        $overridesChanged = $cur === null || self::overrideKeys($overrides) !== self::overrideKeys($cur->overrides);
        for ($attempt = 1; $attempt <= self::MAX_ATTEMPTS; $attempt++) {
            $res = $this->validate($s, $p->uuid, $p->name, $yaml, $overrides, $p);
            if (($res['ok'] ?? false) !== true) {
                // Lưu revision bị chặn để xem report, nhưng không đặt làm hiện hành và không áp dụng.
                $rev = $this->revision($p, $yaml, $res, $overrides, $actor);
                $this->audit->record('compose.validate_rejected', $p, ['revision' => $rev->number,
                    'findings' => $rev->findings_count], 'failure', $s->id, null, $actor);
                throw self::rejected($res);
            }
            try {
                return DB::transaction(function () use ($actor, $p, $s, $yaml, $res, $overrides, $env, $template, $yamlChanged, $overridesChanged, $cur): Job {
                    /** @var ComposeProject $locked */
                    $locked = ComposeProject::query()->lockForUpdate()->findOrFail($p->id);
                    $this->allocate($locked, self::portMaps($res));
                    $rev = ($yamlChanged || $overridesChanged || $cur->validated_sha256 !== ($res['validated_sha256'] ?? null))
                        ? $this->revision($locked, $yaml, $res, $overrides, $actor) : $cur;
                    $fill = ['current_revision_id' => $rev->id, 'template' => $template, 'run_state' => 'deploying',
                        'status' => 'provisioning', 'spec_version' => $locked->spec_version + 1];
                    if ($env !== null) {
                        $fill['env_encrypted'] = $env === [] ? null : Crypt::encryptString((string) json_encode($env));
                    }
                    $locked->forceFill($fill)->save();
                    $job = $this->jobs->dispatch($this->applySpec('compose.update', $locked, $rev), $actor);
                    $this->audit->record('compose.update', $locked, ['revision' => $rev->number, 'yaml_changed' => $yamlChanged,
                        'overrides' => array_map(fn (array $o): array => ['rule' => $o['rule'], 'reason' => $o['reason']], $overrides),
                        'env_keys' => $env !== null ? array_keys($env) : null], 'success', $s->id, $job->id, $actor);

                    return $job;
                });
            } catch (PortConflict) {
                continue;
            }
        }
        throw ApiProblem::conflict('Không cấp được cổng host (đụng nhau liên tục). Thử lại sau.');
    }

    /** @param list<array<string, mixed>> $o */
    private static function overrideKeys(array $o): string
    {
        $k = array_map(fn (array $x): string => $x['rule'].'|'.$x['reason'], $o);
        sort($k);

        return implode("\n", $k);
    }

    /**
     * Các bước áp dụng một revision: validate lại trên node với đúng cổng đã cấp (agent ghi sha), đăng nhập registry
     * cần cho image, rồi compose.apply với YAML đã validate.
     */
    public function applySpec(string $type, ComposeProject $p, ComposeRevision $rev): JobSpec
    {
        $ports = PortAllocation::query()->where('compose_project_id', $p->id)->orderBy('port')->get();
        $spec = (new JobSpec($type, $p, $p->server_id, maxAttempts: 2, timeoutSec: 2400))
            ->step('compose.validate', ['project' => $p->ref(), 'compose_yaml' => $rev->yaml,
                'allocated_ports' => $ports->pluck('port')->map(fn ($x): int => (int) $x)->unique()->values()->all(),
                'defaults' => self::limits(), 'overrides' => array_map(fn (array $o): array => ['rule' => $o['rule'],
                    'reason' => $o['reason'], 'by_user_uuid' => $o['by_user_uuid']], $rev->overrides),
                'allow_home_bind' => false]);
        $regs = $this->registriesFor(array_values((array) ($rev->validation_report['images'] ?? [])));
        foreach ($regs as $r) {
            $spec->step('docker.registry.login', RegistryService::loginParams($r));
        }
        $spec->step('compose.apply', ['project' => $p->ref(), 'revision' => $rev->number,
            'validated_yaml' => (string) $rev->validated_yaml, 'validated_sha256' => (string) $rev->validated_sha256,
            'env' => Secrets::ref('compose_env', $p->uuid),
            'ports' => $ports->map(fn (PortAllocation $a): array => ['service' => $a->service, 'container_port' => $a->container_port,
                'host_port' => $a->port, 'protocol' => $a->protocol])->all(),
            'registry_uuids' => array_map(fn (Registry $r): string => $r->uuid, $regs)]);

        return $spec;
    }

    /**
     * Registry có credential khớp host của image (tối đa 10).
     *
     * @param  list<mixed>  $images
     * @return list<Registry>
     */
    public function registriesFor(array $images): array
    {
        $hosts = [];
        foreach ($images as $img) {
            if (is_string($img)) {
                $hosts[self::registryHost($img)] = true;
            }
        }
        if ($hosts === []) {
            return [];
        }

        return array_values(Registry::query()->whereNotNull('username')->whereNotNull('password_encrypted')->orderBy('id')->get()
            ->filter(fn (Registry $r): bool => isset($hosts[$r->host()]))->take(10)->all());
    }

    /** Khớp docker.RegistryHost của agent: thành phần đầu có `.`/`:` hoặc là localhost → host; còn lại docker.io. */
    public static function registryHost(string $ref): string
    {
        $first = explode('/', $ref, 2);
        if (count($first) === 2 && (str_contains($first[0], '.') || str_contains($first[0], ':') || $first[0] === 'localhost')) {
            return strtolower($first[0]);
        }

        return 'docker.io';
    }

    public function action(User $actor, ComposeProject $p, string $action): Job
    {
        $this->hosts->requireEnabled($p->server);
        $this->ensureIdle($p);
        $rev = $p->currentRevision;
        if ($rev === null || ! $rev->ok) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Chưa có revision hợp lệ', 'Project chưa có revision đã qua validator.');
        }
        $spec = new JobSpec('compose.'.$action, $p, $p->server_id, maxAttempts: 1, timeoutSec: $action === 'pull' ? 1800 : 900);
        match ($action) {
            'validate' => $spec->step('compose.validate', ['project' => $p->ref(), 'compose_yaml' => $rev->yaml,
                'allocated_ports' => PortAllocation::query()->where('compose_project_id', $p->id)->pluck('port')
                    ->map(fn ($x): int => (int) $x)->unique()->values()->all(),
                'defaults' => self::limits(), 'overrides' => array_map(fn (array $o): array => ['rule' => $o['rule'],
                    'reason' => $o['reason'], 'by_user_uuid' => $o['by_user_uuid']], $rev->overrides),
                'allow_home_bind' => false]),
            'up' => $spec->step('compose.up', ['project' => $p->ref()]),
            'down' => $spec->step('compose.down', ['project' => $p->ref()]),
            'pull' => $this->pullSteps($spec, $p, $rev),
            default => throw ApiProblem::field('action', 'Hành động không hợp lệ.'),
        };
        if (in_array($action, ['up', 'down'], true)) {
            $p->forceFill(['run_state' => 'deploying'])->save();
        }
        $job = $this->jobs->dispatch($spec, $actor);
        $this->audit->record('compose.'.$action, $p, ['revision' => $rev->number], 'success', $p->server_id, $job->id, $actor);

        return $job;
    }

    private function pullSteps(JobSpec $spec, ComposeProject $p, ComposeRevision $rev): JobSpec
    {
        $regs = $this->registriesFor(array_values((array) ($rev->validation_report['images'] ?? [])));
        foreach ($regs as $r) {
            $spec->step('docker.registry.login', RegistryService::loginParams($r));
        }

        return $spec->step('compose.pull', ['project' => $p->ref(), 'registry_uuids' => array_map(fn (Registry $r): string => $r->uuid, $regs)]);
    }

    public function delete(User $actor, ComposeProject $p): Job
    {
        $this->ensureIdle($p);
        $sites = Website::query()->where('compose_project_id', $p->id)->pluck('primary_domain')->all();
        if ($sites !== []) {
            throw new ApiProblem(409, 'resource_locked', 'Project đang có website',
                'Xóa website trỏ tới project trước: '.implode(', ', array_slice($sites, 0, 5)).'.');
        }
        $p->forceFill(['status' => 'deleting'])->save();
        $job = $this->jobs->dispatch((new JobSpec('compose.delete', $p, $p->server_id, maxAttempts: 2, timeoutSec: 900))
            ->step('compose.remove', ['project' => $p->ref(), 'remove_volumes' => false]), $actor);
        $this->audit->record('compose.delete', $p, ['name' => $p->name, 'volumes_kept' => true], 'success', $p->server_id, $job->id, $actor);

        return $job;
    }

    /** @param list<mixed> $services */
    public function updateImages(User $actor, ComposeProject $p, array $services): Job
    {
        $this->hosts->requireEnabled($p->server);
        $this->ensureIdle($p);
        $svcs = $this->services($p, $services);
        $job = $this->jobs->dispatch((new JobSpec('compose.update_images', $p, $p->server_id, maxAttempts: 1, timeoutSec: 2400))
            ->step('docker.image.update', ['project' => $p->ref(), 'services' => $svcs,
                'health_timeout_sec' => max(10, min(300, (int) config('itso.docker.health_timeout_sec', 60))),
                'keep_rollbacks' => max(1, min(5, (int) config('itso.docker.keep_rollbacks', 2)))]), $actor);
        $this->audit->record('compose.update_images', $p, ['services' => $svcs], 'success', $p->server_id, $job->id, $actor);

        return $job;
    }

    /** @param list<mixed> $services */
    public function rollbackImages(User $actor, ComposeProject $p, array $services): Job
    {
        $this->hosts->requireEnabled($p->server);
        $this->ensureIdle($p);
        $avail = ImageRollback::query()->where('compose_project_id', $p->id)->where('state', 'succeeded')->whereNull('released_at')
            ->distinct()->pluck('service')->all();
        $svcs = $services === [] ? $avail : $this->services($p, $services);
        $missing = array_values(array_diff($svcs, $avail));
        if ($svcs === [] || $missing !== []) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Không có bản để quay về',
                $missing !== [] ? 'Service chưa có bản image trước: '.implode(', ', $missing).'.' : 'Chưa có lần cập nhật image nào để quay về.');
        }
        sort($svcs);
        $job = $this->jobs->dispatch((new JobSpec('compose.rollback_images', $p, $p->server_id, maxAttempts: 1, timeoutSec: 1200))
            ->step('docker.image.rollback', ['project' => $p->ref(), 'services' => $svcs]), $actor);
        $this->audit->record('compose.rollback_images', $p, ['services' => $svcs], 'success', $p->server_id, $job->id, $actor);

        return $job;
    }

    /**
     * Service của project (theo kết quả compose.apply gần nhất / cache container); rỗng = tất cả.
     *
     * @param  list<mixed>  $requested
     * @return list<string>
     */
    private function services(ComposeProject $p, array $requested): array
    {
        $known = array_values(array_unique(array_merge(array_map('strval', (array) ($p->observed_facts['services'] ?? [])),
            DockerContainer::query()->where('project_id', $p->id)->whereNotNull('service')->pluck('service')->all())));
        sort($known);
        if ($requested === []) {
            if ($known === []) {
                throw new ApiProblem(409, 'invalid_state_transition', 'Project chưa chạy', 'Chưa có service nào đang chạy để cập nhật.');
            }

            return array_slice($known, 0, 50);
        }
        $out = [];
        foreach ($requested as $i => $svc) {
            if (! is_string($svc) || ! in_array($svc, $known, true)) {
                throw ApiProblem::field("services.$i", 'Service không thuộc project.');
            }
            $out[$svc] = $svc;
        }

        return array_values($out);
    }

    public function ensureIdle(ComposeProject $p): void
    {
        $busy = Job::query()->where('resource_type', 'compose_project')->where('resource_id', $p->id)
            ->whereIn('state', ['queued', 'running', 'waiting_agent'])->where('created_at', '>=', Carbon::now()->subHours(2))->exists();
        if ($busy || $p->status === 'deleting') {
            throw new ApiProblem(409, 'resource_locked', 'Project đang bận', 'Chờ job trước của project kết thúc rồi thử lại.');
        }
    }

    public static function etag(ComposeProject $p): string
    {
        return '"c-'.$p->spec_version.'-'.$p->updated_at->getTimestamp().'"';
    }

    /** @return array<string, mixed> ComposeProject */
    public function present(ComposeProject $p): array
    {
        $rev = $p->currentRevision;
        $report = (array) ($rev->validation_report ?? []);
        $users = User::query()->whereIn('uuid', array_filter(array_map(fn (array $o) => $o['by_user_uuid'] ?? null,
            $rev->overrides ?? [])))->get()->keyBy('uuid');
        $rollbacks = ImageRollback::query()->where('compose_project_id', $p->id)->where('state', 'succeeded')->whereNull('released_at')
            ->distinct()->pluck('service')->all();
        $last = ImageRollback::query()->where('compose_project_id', $p->id)->orderByDesc('id')->first();
        $containers = DockerContainer::query()->where('project_id', $p->id)->orderBy('service')->get();

        return [
            'uuid' => $p->uuid, 'server' => ['uuid' => $p->server->uuid, 'name' => $p->server->name], 'name' => $p->name,
            'status' => $p->run_state, 'services' => count(array_unique(array_merge((array) ($p->observed_facts['services'] ?? []),
                $containers->pluck('service')->filter()->all()))),
            'revision' => $rev->number ?? 1, 'template' => $p->template,
            'validation' => ['ok' => (bool) ($rev->ok ?? false), 'findings' => self::findings($report),
                'rewrites' => array_values(array_map(fn (array $r): array => ['service' => (string) ($r['service'] ?? ''),
                    'path' => (string) ($r['path'] ?? ''), 'before' => isset($r['before']) ? (string) $r['before'] : null,
                    'after' => (string) ($r['after'] ?? '')], array_filter((array) ($report['rewrites'] ?? []), 'is_array'))),
                'overrides' => array_values(array_map(function (array $o) use ($users): array {
                    $u = $users[$o['by_user_uuid'] ?? ''] ?? null;

                    return ['rule' => (string) $o['rule'], 'reason' => (string) $o['reason'],
                        'by' => $u instanceof User ? ['uuid' => $u->uuid, 'name' => $u->name, 'email' => $u->email] : null,
                        'at' => isset($o['at']) ? (string) $o['at'] : null];
                }, array_filter((array) ($rev->overrides ?? []), 'is_array'))),
                'validated_yaml' => $rev?->validated_yaml],
            'compose_yaml' => (string) ($rev->yaml ?? ''),
            'ports' => PortAllocation::query()->where('compose_project_id', $p->id)->orderBy('port')->get()
                ->map(fn (PortAllocation $a): array => ['service' => $a->service, 'container_port' => $a->container_port,
                    'host_port' => $a->port, 'protocol' => $a->protocol])->all(),
            'images' => $containers->filter(fn (DockerContainer $c): bool => $c->service !== null)->unique('service')
                ->map(fn (DockerContainer $c): array => ['service' => (string) $c->service, 'image' => $c->image,
                    'digest' => (string) ($c->image_digest ?? ''), 'latest_digest' => null, 'update_available' => false,
                    'rollback_available' => in_array($c->service, $rollbacks, true)])->values()->all(),
            'websites' => Website::query()->where('compose_project_id', $p->id)->orderBy('id')->get()
                ->map(fn (Website $w): array => ['uuid' => $w->uuid, 'domain' => $w->primary_domain, 'service' => (string) $w->compose_service,
                    'ssl' => $w->ssl_mode !== 'none'])->all(),
            'last_image_update' => $last instanceof ImageRollback ? ['state' => $last->state, 'service' => $last->service,
                'from_digest' => $last->from_digest, 'to_digest' => $last->to_digest, 'reason' => $last->reason,
                'at' => $last->created_at->toIso8601String()] : null,
            'volumes' => array_values(array_map('strval', (array) ($report['volumes'] ?? []))),
            'created_at' => $p->created_at->toIso8601String(), 'updated_at' => $p->updated_at->toIso8601String(),
        ];
    }

    /**
     * @param  array<string, mixed>  $report
     * @return list<array<string, mixed>> ComposeFinding
     */
    public static function findings(array $report): array
    {
        return array_values(array_map(fn (array $f): array => ['rule' => (string) ($f['rule'] ?? 'yaml'),
            'severity' => ($f['severity'] ?? 'error') === 'warning' ? 'warning' : 'error',
            'service' => is_string($f['service'] ?? null) ? $f['service'] : null, 'path' => (string) ($f['path'] ?? ''),
            'message' => (string) ($f['message'] ?? ''), 'overridable' => (bool) ($f['overridable'] ?? false)],
            array_filter((array) ($report['findings'] ?? []), 'is_array')));
    }

    /** @return array<string, mixed> ComposeValidation (xem trước, không lưu gì) */
    public function preview(User $actor, Server $s, string $yaml, mixed $overrides): array
    {
        $this->hosts->requireEnabled($s);
        $ov = self::overrides($actor, $overrides);
        $res = $this->validate($s, self::previewUuid($s), 'preview', $yaml, $ov);

        return ['ok' => ($res['ok'] ?? false) === true, 'findings' => self::findings($res),
            'rewrites' => array_values(array_map(fn (array $r): array => ['service' => (string) ($r['service'] ?? ''),
                'path' => (string) ($r['path'] ?? ''), 'before' => isset($r['before']) ? (string) $r['before'] : null,
                'after' => (string) ($r['after'] ?? '')], array_filter((array) ($res['rewrites'] ?? []), 'is_array'))),
            'overrides' => array_map(fn (array $o): array => ['rule' => $o['rule'], 'reason' => $o['reason'],
                'by' => ['uuid' => $actor->uuid, 'name' => $actor->name, 'email' => $actor->email], 'at' => $o['at']], $ov),
            'validated_yaml' => is_string($res['validated_yaml'] ?? null) ? $res['validated_yaml'] : null];
    }
}
