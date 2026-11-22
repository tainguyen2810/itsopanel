<?php

declare(strict_types=1);

namespace App\Domain\Backup;

use App\Domain\Audit\AuditLogger;
use App\Domain\Data\DataSpec;
use App\Domain\Hosting\QuotaService;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Domain\Jobs\Secrets;
use App\Domain\Setup\SetupWizard;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\BackupDestination;
use App\Models\BackupJob;
use App\Models\BackupPolicy;
use App\Models\BackupRepository;
use App\Models\BackupSnapshot;
use App\Models\BackupVerification;
use App\Models\Database;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\PurgeRecord;
use App\Models\Server;
use App\Models\User;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Backup (Prompt 8.4, D-82…D-87): repo theo đích × server × account, job backup (files/DB/cấu hình/panel), kiểm chứng,
 * xóa snapshot (chỉ đích không bất biến), duyệt/tải file từ snapshot, quota theo gói, tổng quan 3-2-1-1-0.
 */
final class BackupService
{
    public const JOB_TYPES = ['backup.run', 'backup.verify', 'backup.forget', 'backup.destination_test', 'backup.restore'];

    /** Số DB tối đa nạp thử trong một restore test (agent-ops maxItems 5). */
    private const TEST_DBS = 5;

    public const READ_CHUNK = 1048576;

    public const DOWNLOAD_MAX = 512 * 1048576;

    public function __construct(private readonly JobDispatcher $jobs, private readonly AuditLogger $audit,
        private readonly QuotaService $quota, private readonly AgentClient $agent, private readonly Secrets $secrets) {}

    // ------------------------------------------------------------------ repo

    /** Repo sống duy nhất cho (đích, server, account|null); mật khẩu 32 byte ngẫu nhiên, Crypt (ADR 0029 §2). */
    public function repository(BackupDestination $d, Server $s, ?HostingAccount $a): BackupRepository
    {
        $path = BackupSpec::repoPath($s, $a);
        $r = BackupRepository::query()->where('destination_id', $d->id)->where('path', $path)->first();
        if ($r instanceof BackupRepository) {
            return $r;
        }

        $r = BackupRepository::query()->create(['destination_id' => $d->id, 'server_id' => $s->id,
            'scope_type' => $a !== null ? 'hosting_account' : 'server', 'hosting_account_id' => $a?->id, 'path' => $path,
            'password_encrypted' => Crypt::encryptString(rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '='))]);
        if ($a === null) {
            DestinationService::kitOutdated($r);
        }

        return $r;
    }

    private function initStep(JobSpec $spec, BackupRepository $r): void
    {
        if ($r->initialized_at === null) {
            $spec->step('backup.repo.init', ['repo' => BackupSpec::repo($r)]);
        }
    }

    /**
     * @param  list<string>  $tags
     * @param  array<string, mixed>  $extra
     * @return array<string, mixed>
     */
    private static function runParams(BackupRepository $r, string $kind, ?HostingAccount $a, array $tags, array $extra = []): array
    {
        $server = $r->server;

        return $extra + ['repo' => BackupSpec::repo($r), 'kind' => $kind, 'account' => $a !== null ? DataSpec::acct($a) : null,
            'website_uuid' => null, 'site_dir' => null, 'databases' => [], 'excludes' => [], 'tags' => array_values(array_unique($tags)),
            'age_recipient' => null, 'meta' => BackupSpec::meta($server, $a)];
    }

    // ------------------------------------------------------------------ backup job

    /**
     * Thêm các bước backup một account vào một repo: init (lần đầu) → files → từng DB → stats.
     *
     * @param  list<string>  $contents  files|databases
     * @param  list<string>  $tags
     * @param  list<string>  $excludes
     */
    public function accountSteps(JobSpec $spec, BackupRepository $r, HostingAccount $a, array $contents, array $tags, array $excludes = [],
        ?Website $website = null, ?Database $only = null): void
    {
        $this->initStep($spec, $r);
        $tags = array_merge(['account:'.$a->uuid], $tags);
        if (in_array('files', $contents, true) && $only === null) {
            $extra = ['excludes' => $excludes];
            if ($website !== null) {
                $extra += ['website_uuid' => $website->uuid, 'site_dir' => $website->primary_domain];
                $tags[] = 'website:'.$website->uuid;
            }
            $spec->step('backup.run', self::runParams($r, 'files', $a, $tags, $extra));
        }
        if (in_array('databases', $contents, true)) {
            $dbs = $only !== null ? collect([$only])
                : Database::query()->where('hosting_account_id', $a->id)->where('status', 'ready')->orderBy('name')->get();
            foreach ($dbs as $db) {
                $spec->step('backup.run', self::runParams($r, 'db', $a, array_merge($tags, ['db:'.$db->name]),
                    ['databases' => [['engine' => $db->engine === 'postgresql' ? 'postgresql' : 'mariadb', 'name' => $db->name]]]));
            }
        }
        $spec->step('backup.stats', ['repo' => BackupSpec::repo($r)]);
    }

    /**
     * Đích dùng cho backup account: đích của policy đang bật phủ account; không có thì mọi đích đang bật.
     *
     * @return Collection<int, BackupDestination>
     */
    public function destinationsFor(HostingAccount $a): Collection
    {
        $ids = DB::table('backup_policy_destinations as pd')->join('backup_policies as p', 'p.id', '=', 'pd.policy_id')
            ->whereNull('p.deleted_at')->where('p.enabled', true)
            ->where(fn ($w) => $w->where('p.scope_type', 'all_accounts')
                ->orWhere(fn ($x) => $x->where('p.scope_type', 'hosting_account')->where('p.scope_id', $a->id)))
            ->pluck('pd.destination_id')->unique()->all();
        $q = BackupDestination::query()->where('enabled', true)->orderBy('id');
        $list = $ids !== [] ? (clone $q)->whereIn('id', $ids)->get() : $q->get();

        return $list;
    }

    /**
     * Backup ngay một account (admin/portal, "trong quota").
     *
     * @param  list<string>  $contents
     */
    public function backupNow(User $actor, HostingAccount $a, array $contents, ?string $note, bool $final = false): Job
    {
        if (in_array('config', $contents, true)) {
            throw ApiProblem::field('contents', 'Backup cấu hình máy chủ chỉ qua chính sách server (SUPER_ADMIN).');
        }
        if ($a->lifecycle_state === 'purged' || in_array($a->lifecycle_state, ['pending', 'provisioning', 'failed'], true)) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Account không backup được', "Account đang {$a->lifecycle_state}.");
        }
        if (! $final && $this->quotaState($a) === 'paused') {
            throw new ApiProblem(409, 'quota_exceeded', 'Vượt quota backup', 'Dung lượng backup của account vượt 120 % quota gói: xóa bớt bản cũ hoặc nâng gói.');
        }
        $dests = $this->destinationsFor($a);
        if ($dests->isEmpty()) {
            throw new ApiProblem(409, 'precondition_failed', 'Chưa có đích backup', 'SUPER_ADMIN cần thêm đích backup trước.');
        }
        $this->ensureIdle($a);

        return DB::transaction(function () use ($actor, $a, $contents, $note, $final, $dests): Job {
            $server = Server::query()->findOrFail($a->server_id);
            $spec = new JobSpec('backup.run', $a, $a->server_id, 3, 6 * 3600);
            $repos = [];
            foreach ($dests as $d) {
                $r = $this->repository($d, $server, $a);
                $repos[] = $r;
                $this->accountSteps($spec, $r, $a, array_values(array_unique($contents)), [$final ? 'final' : 'manual']);
            }
            $job = $this->jobs->dispatch($spec, $actor);
            foreach ($repos as $r) {
                BackupJob::query()->create(['job_id' => $job->id, 'repository_id' => $r->id, 'status' => 'running', 'started_at' => Carbon::now()]);
            }
            $this->audit->record('backup.create', $a, ['contents' => $contents, 'note' => $note, 'final' => $final,
                'destinations' => $dests->pluck('uuid')->all()], 'success', $a->server_id, $job->id, $actor);

            return $job;
        });
    }

    /** 409 nếu account còn job backup/khôi phục chưa xong (một tác vụ một repo, D-86). */
    public function ensureIdle(HostingAccount $a): void
    {
        if (Job::query()->whereIn('type', ['backup.run', 'backup.restore', 'backup.verify', 'backup.forget'])->where('resource_type', 'hosting_account')
            ->where('resource_id', $a->id)->whereIn('state', ['queued', 'running', 'cancel_requested', 'waiting_agent'])->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'Đang có tác vụ backup', 'Chờ tác vụ backup/khôi phục hiện tại của account xong.');
        }
    }

    /**
     * Chạy một policy: mỗi account trong phạm vi một job (bỏ qua account bị tạm dừng do quota); server/panel một job mỗi server.
     *
     * @return list<Job>
     */
    public function runPolicy(BackupPolicy $p, ?User $actor): array
    {
        $dests = $p->destinations()->where('enabled', true)->get();
        if ($dests->isEmpty()) {
            throw new ApiProblem(409, 'precondition_failed', 'Policy không có đích đang bật', 'Gắn ít nhất một đích đang bật.');
        }
        $tag = 'policy:'.$p->uuid;
        $jobs = [];
        $prev = $p->last_status;
        // 'running' trước khi dispatch: job chạy đồng bộ (test/sandbox) để handler ghi kết quả cuối.
        $p->forceFill(['last_run_at' => Carbon::now(), 'last_status' => 'running'])->save();
        foreach ($this->policyTargets($p) as [$server, $account, $website, $db]) {
            if ($account !== null && ($this->quotaState($account) === 'paused' || ! in_array($account->lifecycle_state, ['active', 'suspended'], true))) {
                continue;
            }
            if ($account !== null && Job::query()->where('type', 'backup.run')->where('resource_type', 'hosting_account')->where('resource_id', $account->id)
                ->whereIn('state', ['queued', 'running'])->exists()) {
                continue;
            }
            $jobs[] = DB::transaction(function () use ($p, $actor, $dests, $tag, $server, $account, $website, $db): Job {
                $spec = new JobSpec('backup.run', $account ?? $server, $server->id, 3, 6 * 3600);
                $repos = [];
                foreach ($dests as $d) {
                    $r = $this->repository($d, $server, $account);
                    $repos[] = $r;
                    if ($account !== null) {
                        $this->accountSteps($spec, $r, $account, $p->contents, [$tag], $p->excludes, $website, $db);
                    } else {
                        $this->initStep($spec, $r);
                        $kind = $p->scope_type === 'panel' ? 'panel' : 'config';
                        $spec->step('backup.run', self::runParams($r, $kind, null, [$tag],
                            $kind === 'panel' ? ['age_recipient' => AgeKeys::publicKey()] : []));
                        $spec->step('backup.stats', ['repo' => BackupSpec::repo($r)]);
                    }
                }
                $job = $this->jobs->dispatch($spec, $actor);
                foreach ($repos as $r) {
                    BackupJob::query()->create(['policy_id' => $p->id, 'job_id' => $job->id, 'repository_id' => $r->id, 'status' => 'running',
                        'started_at' => Carbon::now()]);
                }

                return $job;
            });
        }
        if ($jobs === []) {
            $p->forceFill(['last_status' => $prev])->save();
        }

        return $jobs;
    }

    /** @return list<array{0: Server, 1: HostingAccount|null, 2: Website|null, 3: Database|null}> */
    public function policyTargets(BackupPolicy $p): array
    {
        $out = [];
        switch ($p->scope_type) {
            case 'all_accounts':
                foreach (HostingAccount::query()->whereIn('lifecycle_state', ['active', 'suspended'])->orderBy('id')->get() as $a) {
                    $out[] = [Server::query()->findOrFail($a->server_id), $a, null, null];
                }
                break;
            case 'hosting_account':
                $a = HostingAccount::query()->find($p->scope_id);
                if ($a instanceof HostingAccount) {
                    $out[] = [Server::query()->findOrFail($a->server_id), $a, null, null];
                }
                break;
            case 'website':
                $w = Website::query()->find($p->scope_id);
                $a = $w instanceof Website ? HostingAccount::query()->find($w->hosting_account_id) : null;
                if ($w instanceof Website && $a instanceof HostingAccount) {
                    $out[] = [Server::query()->findOrFail($a->server_id), $a, $w, null];
                }
                break;
            case 'database':
                $d = Database::query()->find($p->scope_id);
                $a = $d instanceof Database ? HostingAccount::query()->find($d->hosting_account_id) : null;
                if ($d instanceof Database && $a instanceof HostingAccount) {
                    $out[] = [Server::query()->findOrFail($a->server_id), $a, null, $d];
                }
                break;
            case 'server':
                $s = Server::query()->find($p->scope_id);
                if ($s instanceof Server) {
                    $out[] = [$s, null, null, null];
                }
                break;
            case 'panel':
                $s = SetupWizard::localServer();
                if ($s instanceof Server) {
                    $out[] = [$s, null, null, null];
                }
                break;
        }

        return $out;
    }

    // ------------------------------------------------------------------ kiểm chứng

    /** Kiểm chứng một snapshot: restic check (5 % dữ liệu) + restore test (manifest sha256 + nạp DB tạm). */
    public function verify(?User $actor, BackupSnapshot $s, int $readPercent = 5): Job
    {
        $r = $s->repository;
        $a = $s->hosting_account_id !== null ? HostingAccount::query()->find($s->hosting_account_id) : null;
        if ($a !== null) {
            $this->ensureIdle($a);
        }

        return DB::transaction(function () use ($actor, $s, $r, $a, $readPercent): Job {
            $dbs = [];
            foreach (array_slice($s->databases, 0, self::TEST_DBS) as $name) {
                $eng = $a !== null ? Database::withTrashed()->where('hosting_account_id', $a->id)->where('name', $name)->value('engine') : null;
                $dbs[] = ['engine' => $eng === 'postgresql' ? 'postgresql' : 'mariadb', 'name' => $name];
            }
            if ($s->scope_type === 'panel') {
                $dbs = [];
            }
            $spec = (new JobSpec('backup.verify', $a ?? $r->server, $r->server_id, 2, 4 * 3600))
                ->step('backup.check', ['repo' => BackupSpec::repo($r), 'read_data_percent' => $readPercent])
                ->step('backup.restore_test', ['repo' => BackupSpec::repo($r), 'snapshot_id' => $s->restic_snapshot_id, 'sample_files' => 50,
                    'databases' => $dbs]);
            $job = $this->jobs->dispatch($spec, $actor);
            foreach (['check', 'restore_test'] as $kind) {
                BackupVerification::query()->create(['destination_id' => $s->destination_id, 'repository_id' => $r->id,
                    'hosting_account_id' => $s->hosting_account_id, 'snapshot_id' => $kind === 'restore_test' ? $s->id : null, 'kind' => $kind,
                    'state' => 'running', 'read_data_percent' => $kind === 'check' ? $readPercent : null, 'job_id' => $job->id,
                    'started_at' => Carbon::now()]);
            }
            if ($actor !== null) {
                $this->audit->record('backup.verify', $a ?? $r->server, ['snapshot' => $s->uuid], 'success', $r->server_id, $job->id, $actor);
            }

            return $job;
        });
    }

    /** restic check định kỳ một repo (không gắn snapshot). */
    public function checkRepo(BackupRepository $r, int $readPercent): Job
    {
        return DB::transaction(function () use ($r, $readPercent): Job {
            $spec = (new JobSpec('backup.verify', $r->account ?? $r->server, $r->server_id, 2, 4 * 3600))
                ->step('backup.check', ['repo' => BackupSpec::repo($r), 'read_data_percent' => $readPercent]);
            $job = $this->jobs->dispatch($spec, null);
            BackupVerification::query()->create(['destination_id' => $r->destination_id, 'repository_id' => $r->id,
                'hosting_account_id' => $r->hosting_account_id, 'kind' => 'check', 'state' => 'running', 'read_data_percent' => $readPercent,
                'job_id' => $job->id, 'started_at' => Carbon::now()]);

            return $job;
        });
    }

    // ------------------------------------------------------------------ xóa snapshot / retention

    /** Xóa snapshot (SUPER_ADMIN + step-up): chỉ đích không bất biến và hết khóa; agent còn chặn bằng policy backup.forget. */
    public function deleteSnapshot(User $actor, BackupSnapshot $s): Job
    {
        $d = $s->destination;
        if ($d->immutable() || ($s->locked_until !== null && $s->locked_until->isFuture())) {
            throw new ApiProblem(409, 'precondition_failed', 'Snapshot bất biến', 'Đích append-only/Object Lock: chỉ prune được bằng "itso backup prune" trên máy chủ (credential prune nhập tại chỗ).');
        }
        if (PurgeRecord::query()->where('final_backup_snapshot_id', $s->id)->whereNull('completed_at')->exists()) {
            throw new ApiProblem(409, 'precondition_failed', 'Snapshot là backup cuối trước purge', 'Không xóa backup cuối của biên bản purge đang mở (D-46).');
        }

        return $this->forget($actor, $s->repository, collect([$s]), 'backup.delete');
    }

    /** @param Collection<int, BackupSnapshot> $snaps */
    public function forget(?User $actor, BackupRepository $r, Collection $snaps, string $action): Job
    {
        return DB::transaction(function () use ($actor, $r, $snaps, $action): Job {
            $spec = (new JobSpec('backup.forget', $r->account ?? $r->server, $r->server_id, 1, 3600))
                ->step('backup.forget', ['repo' => BackupSpec::repo($r), 'snapshot_ids' => $snaps->pluck('restic_snapshot_id')->values()->all(),
                    'prune' => true]);
            $job = $this->jobs->dispatch($spec, $actor);
            $this->audit->record($action, $r->account ?? $r->server, ['snapshots' => $snaps->pluck('uuid')->all()], 'success', $r->server_id,
                $job->id, $actor);

            return $job;
        });
    }

    /**
     * Snapshot cần forget theo retention mong muốn (last/hourly/daily/weekly/monthly; cùng nhóm phạm vi + tag policy).
     *
     * @param  Collection<int, BackupSnapshot>  $snaps  mới nhất trước
     * @param  array<string, int>  $keep
     * @return Collection<int, BackupSnapshot>
     */
    public static function expired(Collection $snaps, array $keep): Collection
    {
        $keepIds = [];
        $last = (int) ($keep['last'] ?? 0);
        foreach ($snaps->take($last) as $s) {
            $keepIds[$s->id] = true;
        }
        foreach (['hourly' => 'Y-m-d H', 'daily' => 'Y-m-d', 'weekly' => 'o-W', 'monthly' => 'Y-m'] as $k => $fmt) {
            $n = (int) ($keep[$k] ?? 0);
            $seen = [];
            foreach ($snaps as $s) {
                $b = $s->taken_at->format($fmt);
                if (count($seen) >= $n) {
                    break;
                }
                if (! isset($seen[$b])) {
                    $seen[$b] = true;
                    $keepIds[$s->id] = true;
                }
            }
        }
        if ($keepIds === []) {
            return collect();
        }

        return $snaps->filter(fn (BackupSnapshot $s) => ! isset($keepIds[$s->id]) && ! in_array('final', $s->tags, true)
            && ! in_array('pre-restore', $s->tags, true))->values();
    }

    /**
     * Áp retention của policy sau khi chạy xong (chỉ đích không bất biến; agent có thể vẫn chặn bằng policy).
     *
     * @param  list<int>|null  $onlyRepos  repo của job vừa xong (null = mọi repo của policy)
     */
    public function applyRetention(BackupPolicy $p, ?array $onlyRepos = null): void
    {
        $keep = array_filter(array_map('intval', $p->retention), fn (int $v) => $v > 0);
        if ($keep === []) {
            return;
        }
        $repoIds = $onlyRepos ?? BackupJob::query()->where('policy_id', $p->id)->pluck('repository_id')->unique()->filter()->all();
        foreach (BackupRepository::query()->whereIn('id', $repoIds)->get() as $r) {
            if ($r->destination->immutable()) {
                continue;
            }
            $snaps = BackupSnapshot::query()->where('repository_id', $r->id)->whereRaw('? = ANY(tags)', ['policy:'.$p->uuid])
                ->orderByDesc('taken_at')->get();
            $groups = $snaps->groupBy(fn (BackupSnapshot $s) => $s->scope_type.'|'.implode(',', $s->databases));
            $old = $groups->flatMap(fn (Collection $g) => self::expired($g->values(), $keep))->values();
            if ($old->isNotEmpty()) {
                $this->forget(null, $r, $old, 'backup.retention');
            }
        }
    }

    // ------------------------------------------------------------------ quota (D-86)

    /** ok | warn (> 100 %) | paused (> 120 %) theo backup_quota_mb của gói; 0 = không giới hạn. */
    public function quotaState(HostingAccount $a): string
    {
        $limit = (int) ($this->quota->limits($a)['backup_quota_mb'] ?? 0);
        if ($limit <= 0) {
            return 'ok';
        }
        $used = $this->usedMb($a);

        return $used > $limit * 1.2 ? 'paused' : ($used > $limit ? 'warn' : 'ok');
    }

    public function usedMb(HostingAccount $a): float
    {
        return round(((int) BackupRepository::query()->where('hosting_account_id', $a->id)->sum('size_bytes')) / 1048576, 1);
    }

    public function refreshQuota(HostingAccount $a): void
    {
        $state = $this->quotaState($a);
        BackupRepository::query()->where('hosting_account_id', $a->id)->update(['quota_state' => $state]);
    }

    // ------------------------------------------------------------------ duyệt / tải file (đồng bộ qua agent)

    /** @return list<array<string, mixed>> FileEntry */
    public function browse(User $actor, BackupSnapshot $s, string $path, int $limit): array
    {
        $path = DataSpec::relPath($path, 'path');
        $d = $this->sync($actor, $s->repository->server_id, 'backup.browse', ['repo' => BackupSpec::repo($s->repository), 'snapshot_id' => $s->restic_snapshot_id,
            'path' => $path, 'limit' => $limit]);
        $owner = $s->account->username ?? 'root';

        return array_values(array_map(fn (array $e): array => ['name' => (string) $e['name'], 'path' => (string) $e['path'], 'type' => (string) $e['type'],
            'size' => (int) $e['size'], 'mode' => (string) $e['mode'], 'owner' => $owner,
            'modified_at' => Carbon::parse((string) $e['mtime'])->toIso8601String()], (array) ($d['entries'] ?? [])));
    }

    /** @return array{url: string, expires_at: string} */
    public function downloadLink(User $actor, BackupSnapshot $s, mixed $path, string $realm): array
    {
        if ($path === null) {
            throw ApiProblem::field('path', 'Chỉ tải từng file; muốn lấy cả snapshot hãy khôi phục.');
        }
        $path = DataSpec::relPath($path, 'path', false);
        $exp = Carbon::now()->getTimestamp() + 300;

        return ['url' => url("/api/v1/$realm/backup-snapshots/{$s->uuid}/raw").'?'.http_build_query(['path' => $path, 'expires' => $exp,
            'signature' => self::sign($s, $path, $exp, $actor)]),
            'expires_at' => Carbon::createFromTimestamp($exp)->toIso8601String()];
    }

    public static function sign(BackupSnapshot $s, string $path, int $exp, User $u): string
    {
        return hash_hmac('sha256', "backup.raw|{$s->uuid}|$path|$exp|{$u->id}", (string) config('app.key'));
    }

    /**
     * Kiểm chữ ký + đọc khúc đầu; trả [kích thước, tên, khúc đầu].
     *
     * @return array{0: int, 1: string, 2: string}
     */
    public function openDownload(User $actor, BackupSnapshot $s, mixed $path, mixed $exp, mixed $sig): array
    {
        $path = DataSpec::relPath($path, 'path', false);
        if (! is_string($exp) || ! ctype_digit($exp) || (int) $exp < Carbon::now()->getTimestamp() || ! is_string($sig)
            || ! hash_equals(self::sign($s, $path, (int) $exp, $actor), $sig)) {
            throw new ApiProblem(403, 'forbidden', 'Link tải xuống không hợp lệ hoặc đã hết hạn', 'Tạo link mới.');
        }
        $d = $this->chunk($actor, $s, $path, 0);
        $this->audit->record('backup.download', $s->account ?? $s->repository->server, ['snapshot' => $s->uuid, 'path' => $path,
            'size' => $d['size']], 'success', $s->repository->server_id, null, $actor);

        return [$d['size'], basename($path), $d['data']];
    }

    /** @return array{data: string, size: int, eof: bool} */
    public function chunk(User $actor, BackupSnapshot $s, string $path, int $offset): array
    {
        $d = $this->sync($actor, $s->repository->server_id, 'backup.file.read', ['repo' => BackupSpec::repo($s->repository), 'snapshot_id' => $s->restic_snapshot_id,
            'path' => $path, 'offset' => $offset, 'max_bytes' => self::READ_CHUNK]);

        return ['data' => base64_decode((string) ($d['content_b64'] ?? ''), true) ?: '', 'size' => (int) ($d['size'] ?? 0),
            'eof' => (bool) ($d['eof'] ?? true)];
    }

    /**
     * Gọi op đồng bộ: bí mật chỉ được giải ngay trước khi gửi, không ghi đâu cả.
     *
     * @param  array<string, mixed>  $params
     * @return array<string, mixed>
     */
    private function sync(User $actor, ?int $serverId, string $op, array $params): array
    {
        try {
            $res = $this->agent->forServer($serverId)->call($op, $this->secrets->resolve($params), (string) Str::uuid7().':1:1',
                ['user_uuid' => $actor->uuid, 'role' => $actor->roleKey() ?? 'SYSTEM'], 60.0);
        } catch (AgentUnavailable $e) {
            throw new ApiProblem(503, 'agent_unavailable', 'Agent không kết nối được', mb_substr($e->getMessage(), 0, 200));
        }
        if (! $res->ok) {
            $code = (string) ($res->error['code'] ?? 'internal');
            $status = match ($code) {
                'not_found' => 404, 'invalid_params', 'path_outside_home' => 422, 'repo_locked' => 409, default => 409,
            };
            throw new ApiProblem($status, $code === 'invalid_params' ? 'validation_failed' : $code, 'Agent từ chối',
                mb_substr((string) ($res->error['message'] ?? ''), 0, 300));
        }

        return (array) $res->data;
    }
}
