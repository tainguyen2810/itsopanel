<?php

declare(strict_types=1);

namespace App\Domain\Backup;

use App\Domain\Jobs\JobHandler;
use App\Models\BackupDestination;
use App\Models\BackupJob;
use App\Models\BackupPolicy;
use App\Models\BackupRepository;
use App\Models\BackupSnapshot;
use App\Models\BackupVerification;
use App\Models\Database;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\PurgeRecord;
use App\Models\RestoreJob;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Ghi nhận kết quả job backup (Prompt 8.4): repo init → initialized_at; backup.run → backup_snapshots (+ khóa Object Lock);
 * stats → dung lượng + quota; kiểm tra đích → ghim host key/phát hiện; check/restore test → verification (+ cổng purge);
 * restore → restore_jobs, DB mới sẵn sàng, snapshot pre-restore; forget → xóa hàng snapshot; purge → biên bản.
 * Bước đã thành công vẫn được ghi nhận khi job thất bại ở bước sau (snapshot đã nằm trong repo).
 */
final class BackupJobHandler implements JobHandler
{
    public const TYPES = ['backup.run', 'backup.verify', 'backup.forget', 'backup.destination_test', 'backup.restore', 'hosting_account.purge',
        DisasterRecovery::JOB_TYPE];

    public function __construct(private readonly BackupService $backups) {}

    public function succeeded(Job $job): void
    {
        $this->record($job, true);
    }

    public function failed(Job $job): void
    {
        $this->record($job, false);
    }

    private function record(Job $job, bool $ok): void
    {
        $now = Carbon::now();
        $steps = JobStep::query()->where('job_id', $job->id)->orderBy('seq')->get();
        $snaps = [];
        $runRepos = [];
        $restores = [];
        foreach ($steps as $st) {
            $p = $st->params_redacted;
            $res = $st->result ?? [];
            $done = $st->state === 'succeeded';
            $repo = isset($p['repo']['repo_uuid']) ? BackupRepository::query()->where('uuid', $p['repo']['repo_uuid'])->first() : null;
            $err = is_array($res['error'] ?? null) ? mb_substr((string) ($res['error']['message'] ?? ''), 0, 500) : null;
            switch ($st->op) {
                case 'backup.repo.init':
                    if ($done && $repo instanceof BackupRepository && $repo->initialized_at === null) {
                        $repo->forceFill(['initialized_at' => $now])->save();
                    }
                    break;
                case 'backup.run':
                    if ($repo instanceof BackupRepository) {
                        $runRepos[$repo->id] = $repo;
                        if ($done && is_string($res['snapshot_id'] ?? null)) {
                            $snaps[] = [$repo, $this->snapshot($job, $repo, $p, $res, $st->finished_at ?? $now)];
                        }
                    }
                    break;
                case 'backup.stats':
                    if ($done && $repo instanceof BackupRepository) {
                        $last = BackupSnapshot::query()->where('repository_id', $repo->id)->max('taken_at');
                        $repo->forceFill(['size_bytes' => (int) ($res['raw_size_bytes'] ?? 0), 'snapshots_count' => (int) ($res['snapshots'] ?? 0),
                            'last_snapshot_at' => $last])->save();
                        if ($repo->hosting_account_id !== null && ($a = HostingAccount::withTrashed()->find($repo->hosting_account_id)) instanceof HostingAccount) {
                            $this->backups->refreshQuota($a);
                        }
                    }
                    break;
                case 'backup.destination.test':
                    $this->destinationTested($p, $done ? $res : null, $err, $now);
                    break;
                case 'backup.check':
                    $this->verification($job, 'check', $done, $res, $err, $now, $repo);
                    break;
                case 'backup.restore_test':
                    $this->verification($job, 'restore_test', $done, $res, $err, $now, $repo);
                    break;
                case 'backup.forget':
                    if ($done && $repo instanceof BackupRepository) {
                        $this->forgotten($repo, (array) ($p['snapshot_ids'] ?? []));
                    }
                    break;
                case 'backup.restore':
                    $restores[] = [$p, $done ? $res : null, $err];
                    break;
                case 'account.remove':
                    if ($done) {
                        $this->purged($job, $p, $res, $now);
                    }
                    break;
            }
        }
        if ($restores !== []) {
            $this->restored($job, $restores, $now);
        }
        if ($job->type === DisasterRecovery::JOB_TYPE) {
            DisasterRecovery::forget($job);
        }
        // Bước chưa chạy (job dừng sớm): verification còn running → failed.
        BackupVerification::query()->where('job_id', $job->id)->where('state', 'running')
            ->update(['state' => 'failed', 'error' => mb_substr((string) ($job->error_message ?? 'Job dừng trước bước này.'), 0, 500), 'finished_at' => $now]);
        if ($job->type === 'backup.run') {
            $this->runFinished($job, $ok, $snaps, $runRepos, $now);
        }
    }

    /**
     * @param  array<string, mixed>  $p
     * @param  array<string, mixed>  $res
     */
    private function snapshot(Job $job, BackupRepository $repo, array $p, array $res, Carbon $at): BackupSnapshot
    {
        $existing = BackupSnapshot::query()->where('repository_id', $repo->id)->where('restic_snapshot_id', $res['snapshot_id'])->first();
        if ($existing instanceof BackupSnapshot) {
            return $existing;
        }
        $kind = (string) ($p['kind'] ?? 'files');
        $dbs = array_values(array_map(fn ($d) => (string) ($d['name'] ?? ''), (array) ($p['databases'] ?? [])));
        $acc = $repo->hosting_account_id;
        $website = is_string($p['website_uuid'] ?? null) ? Website::withTrashed()->where('uuid', $p['website_uuid'])->first() : null;
        [$scope, $scopeId, $contents] = match ($kind) {
            'db' => ['database', count($dbs) === 1 && $acc !== null
                ? Database::withTrashed()->where('hosting_account_id', $acc)->where('name', $dbs[0])->value('id') : null, ['databases']],
            'config' => ['server_config', $repo->server_id, ['config']],
            'panel' => ['panel', null, ['config']],
            default => $website instanceof Website ? ['website', $website->id, ['files']] : ['hosting_account', $acc, ['files']],
        };
        $d = BackupDestination::withTrashed()->findOrFail($repo->destination_id);
        $tags = array_values(array_unique(array_merge(['itso', 'type:'.$kind], array_map('strval', (array) ($p['tags'] ?? [])))));

        return BackupSnapshot::query()->create(['destination_id' => $repo->destination_id, 'repository_id' => $repo->id,
            'restic_snapshot_id' => (string) $res['snapshot_id'], 'scope_type' => $scope, 'scope_id' => $scopeId !== null ? (int) $scopeId : null,
            'hosting_account_id' => $acc, 'website_id' => $website?->id, 'databases' => $dbs, 'contents' => $contents, 'tags' => $tags,
            'size_bytes' => (int) ($res['size_bytes'] ?? 0), 'panel_version' => is_string($p['meta']['panel_version'] ?? null) ? $p['meta']['panel_version'] : null,
            'meta' => ['bytes_added' => (int) ($res['bytes_added'] ?? 0), 'files_new' => (int) ($res['files_new'] ?? 0),
                'duration_ms' => (int) ($res['duration_ms'] ?? 0), 'manifest_sha256' => $res['manifest_sha256'] ?? null],
            'locked_until' => $d->immutable_days !== null ? $at->copy()->addDays($d->immutable_days) : null,
            'job_id' => $job->id, 'taken_at' => $at]);
    }

    /**
     * Xóa hàng snapshot đã forget; lịch sử (backup_jobs, verification, khôi phục, biên bản purge đã xong) giữ lại với tham chiếu null.
     *
     * @param  array<array-key, mixed>  $resticIds
     */
    private function forgotten(BackupRepository $repo, array $resticIds): void
    {
        $ids = BackupSnapshot::query()->where('repository_id', $repo->id)->whereIn('restic_snapshot_id', $resticIds)->pluck('id')->all();
        if ($ids === []) {
            return;
        }
        BackupJob::query()->whereIn('snapshot_id', $ids)->update(['snapshot_id' => null]);
        BackupVerification::query()->whereIn('snapshot_id', $ids)->update(['snapshot_id' => null]);
        RestoreJob::query()->whereIn('snapshot_id', $ids)->update(['snapshot_id' => null]);
        RestoreJob::query()->whereIn('pre_restore_snapshot_id', $ids)->update(['pre_restore_snapshot_id' => null]);
        PurgeRecord::query()->whereIn('final_backup_snapshot_id', $ids)->update(['final_backup_snapshot_id' => null]);
        BackupSnapshot::query()->whereIn('id', $ids)->delete();
    }

    /**
     * @param  list<array{0: BackupRepository, 1: BackupSnapshot}>  $snaps
     * @param  array<int, BackupRepository>  $repos
     */
    private function runFinished(Job $job, bool $ok, array $snaps, array $repos, Carbon $now): void
    {
        foreach (BackupJob::query()->where('job_id', $job->id)->get() as $bj) {
            $mine = array_values(array_filter($snaps, fn (array $s) => $s[0]->id === $bj->repository_id));
            $bj->forceFill(['status' => $ok ? 'succeeded' : 'failed', 'finished_at' => $now,
                'snapshot_id' => $mine !== [] ? end($mine)[1]->id : null,
                'bytes_added' => array_sum(array_map(fn (array $s) => (int) ($s[1]->meta['bytes_added'] ?? 0), $mine)),
                'files_new' => array_sum(array_map(fn (array $s) => (int) ($s[1]->meta['files_new'] ?? 0), $mine))])->save();
        }
        $policyIds = BackupJob::query()->where('job_id', $job->id)->whereNotNull('policy_id')->pluck('policy_id')->unique();
        foreach (BackupPolicy::query()->whereIn('id', $policyIds)->get() as $pol) {
            $running = BackupJob::query()->where('policy_id', $pol->id)->where('status', 'running')->exists();
            $status = ! $ok ? 'failed' : ($pol->last_status === 'failed' ? 'failed' : ($running ? 'running' : 'succeeded'));
            $pol->forceFill(['last_status' => $status])->save();
            if ($ok) {
                $this->backups->applyRetention($pol, array_keys($repos));
            }
        }
        // Cổng purge (D-46): backup cuối xong → kiểm chứng ngay snapshot files của account.
        if ($ok && $job->resource_type === 'hosting_account') {
            $final = array_values(array_filter($snaps, fn (array $s) => in_array('final', $s[1]->tags, true)));
            $pr = PurgeRecord::query()->where('hosting_account_id', $job->resource_id)->whereNull('completed_at')
                ->whereNull('final_backup_snapshot_id')->latest('id')->first();
            if ($final !== [] && $pr instanceof PurgeRecord) {
                $pick = collect($final)->first(fn (array $s) => $s[1]->scope_type === 'hosting_account') ?? $final[0];
                $pr->forceFill(['final_backup_snapshot_id' => $pick[1]->id])->save();
                $this->backups->verify(null, $pick[1]);
            }
        }
    }

    /**
     * @param  array<string, mixed>  $p
     * @param  array<string, mixed>|null  $res
     */
    private function destinationTested(array $p, ?array $res, ?string $err, Carbon $now): void
    {
        $uuid = $p['destination']['destination_uuid'] ?? null;
        $d = is_string($uuid) ? BackupDestination::query()->where('uuid', $uuid)->first() : null;
        if (! $d instanceof BackupDestination) {
            return;
        }
        if ($res === null) {
            $d->forceFill(['last_check_at' => $now, 'last_check_ok' => false, 'last_check_error' => $err ?? 'Kiểm tra thất bại.'])->save();

            return;
        }
        $ok = (bool) ($res['ok'] ?? false);
        $attrs = ['last_check_at' => $now, 'last_check_ok' => $ok, 'last_check_error' => $ok ? null : mb_substr((string) ($res['error'] ?? ''), 0, 500),
            'detected' => ['append_only' => (bool) ($res['append_only'] ?? false), 'object_lock_days' => $res['object_lock_days'] ?? null]];
        if (is_string($res['ssh_public_key'] ?? null)) {
            $attrs['ssh_public_key'] = $res['ssh_public_key'];
        }
        // Ghim host key lần đầu (TOFU, ADR 0030); agent từ chối khi khác bản đã ghim.
        if ($d->host_key_sha256 === null && is_string($res['host_key_sha256'] ?? null)) {
            $attrs['host_key_sha256'] = $res['host_key_sha256'];
        }
        $d->forceFill($attrs)->save();
    }

    /** @param  array<string, mixed>  $res */
    private function verification(Job $job, string $kind, bool $done, array $res, ?string $err, Carbon $now, ?BackupRepository $repo): void
    {
        $v = BackupVerification::query()->where('job_id', $job->id)->where('kind', $kind)->where('state', 'running')->orderBy('id')->first();
        if (! $v instanceof BackupVerification) {
            return;
        }
        $ok = $done && (bool) ($res['ok'] ?? false);
        $mism = $kind === 'restore_test' ? count((array) ($res['mismatches'] ?? [])) : count((array) ($res['errors'] ?? []));
        $error = ! $done ? ($err ?? 'Bước thất bại.') : ($ok ? null : mb_substr(implode('; ', array_map(
            fn ($e) => is_array($e) ? (string) ($e['path'] ?? '') : (string) $e, array_slice((array) ($res['errors'] ?? $res['mismatches'] ?? []), 0, 5))), 0, 500));
        $v->forceFill(['state' => $ok ? 'succeeded' : 'failed', 'finished_at' => $now, 'mismatches' => $mism, 'error' => $error,
            'files_checked' => $kind === 'restore_test' ? (int) ($res['verified_files'] ?? 0) : null])->save();
        if ($kind === 'check' && $repo instanceof BackupRepository) {
            $repo->forceFill(['last_check_at' => $now, 'last_check_ok' => $ok])->save();
        }
        if ($kind === 'restore_test' && $ok && $v->snapshot_id !== null) {
            BackupSnapshot::query()->whereKey($v->snapshot_id)->update(['verified_at' => $now]);
            // Cổng purge: chỉ khi cả check lẫn restore test của job này đều đạt.
            $checkOk = ! BackupVerification::query()->where('job_id', $job->id)->where('kind', 'check')->where('state', '!=', 'succeeded')->exists();
            if ($checkOk) {
                PurgeRecord::query()->where('final_backup_snapshot_id', $v->snapshot_id)->whereNull('completed_at')
                    ->update(['backup_verified_at' => $now]);
            }
        }
    }

    /**
     * Một job khôi phục có thể nhiều bước backup.restore (DR: mỗi website/database một bước ghi đè): gộp kết quả.
     *
     * @param  list<array{0: array<string, mixed>, 1: array<string, mixed>|null, 2: string|null}>  $steps
     */
    private function restored(Job $job, array $steps, Carbon $now): void
    {
        $rj = RestoreJob::query()->where('job_id', $job->id)->first();
        if (! $rj instanceof RestoreJob) {
            return;
        }
        $acc = HostingAccount::withTrashed()->find($rj->hosting_account_id);
        $newNames = [];
        $paths = [];
        $restoredDbs = [];
        $skipped = [];
        $errors = [];
        $preId = null;
        foreach ($steps as [$p, $res, $err]) {
            if (($p['mode'] ?? '') === 'new') {
                foreach ((array) ($p['items'] ?? []) as $i) {
                    if (($i['kind'] ?? '') === 'database') {
                        $newNames[] = (string) ($i['target_name'] ?? '');
                    }
                }
            }
            if ($res === null) {
                $errors[] = $err ?? (string) ($job->error_message ?? 'Khôi phục thất bại.');

                continue;
            }
            $paths = array_merge($paths, array_values((array) ($res['restored_paths'] ?? [])));
            $restoredDbs = array_merge($restoredDbs, array_values((array) ($res['databases'] ?? [])));
            $skipped = array_merge($skipped, (array) ($res['skipped'] ?? []));
            $preId ??= is_string($res['pre_restore_snapshot_id'] ?? null) ? $res['pre_restore_snapshot_id'] : null;
        }
        $pending = Database::query()->where('hosting_account_id', $rj->hosting_account_id)->where('status', 'provisioning')
            ->whereIn('name', $newNames)->get();
        foreach ($pending as $db) {
            if (in_array($db->name, $restoredDbs, true)) {
                $db->forceFill(['status' => 'ready', 'observed_at' => $now])->save();
            } else {
                $db->delete();
            }
        }
        $pre = null;
        if ($preId !== null && $acc instanceof HostingAccount) {
            $src = $rj->snapshot_id !== null ? BackupSnapshot::query()->find($rj->snapshot_id) : null;
            if ($src instanceof BackupSnapshot) {
                $pre = BackupSnapshot::query()->create(['destination_id' => $src->destination_id, 'repository_id' => $src->repository_id,
                    'restic_snapshot_id' => $preId, 'scope_type' => $src->scope_type, 'scope_id' => $src->scope_id,
                    'hosting_account_id' => $acc->id, 'website_id' => $src->website_id, 'databases' => $src->databases, 'contents' => $src->contents,
                    'tags' => ['itso', 'pre-restore', 'account:'.$acc->uuid], 'job_id' => $job->id, 'taken_at' => $now,
                    'locked_until' => ($days = BackupDestination::withTrashed()->find($src->destination_id)?->immutable_days) !== null ? $now->copy()->addDays($days) : null]);
            }
        }
        $ok = $errors === [];
        $any = $paths !== [] || $restoredDbs !== [];
        $rj->forceFill(['status' => $ok ? 'succeeded' : 'failed', 'finished_at' => $now, 'pre_restore_snapshot_id' => $pre?->id,
            'error' => $ok ? null : mb_substr(implode('; ', array_unique($errors)), 0, 1000),
            'result' => $ok || $any ? ['restored_paths' => array_values(array_unique($paths)), 'databases' => array_values(array_unique($restoredDbs)),
                'skipped' => array_slice($skipped, 0, 100)] : $rj->result])->save();
    }

    /**
     * @param  array<string, mixed>  $p
     * @param  array<string, mixed>  $res
     */
    private function purged(Job $job, array $p, array $res, Carbon $now): void
    {
        // account.remove dùng chung cho purge và dọn nguồn sau chuyển account (Phase 9): chỉ xử lý purge ở đây.
        if (($p['reason'] ?? null) !== 'purge') {
            return;
        }
        $pr = is_string($p['ref_uuid'] ?? null) ? PurgeRecord::query()->where('uuid', $p['ref_uuid'])->first() : null;
        $a = $pr instanceof PurgeRecord ? HostingAccount::withTrashed()->find($pr->hosting_account_id) : null;
        if (! $pr instanceof PurgeRecord || ! $a instanceof HostingAccount) {
            return;
        }
        $objects = array_values(array_map(fn ($o) => ['kind' => (string) ($o['kind'] ?? ''), 'name' => (string) ($o['name'] ?? ''),
            'sha256' => isset($o['sha256']) ? (string) $o['sha256'] : null], (array) ($res['removed_objects'] ?? [])));
        $pr->forceFill(['completed_at' => $now, 'objects' => $objects])->save();
        foreach (['websites', 'databases', 'database_users', 'cron_jobs', 'sftp_accounts'] as $t) {
            DB::table($t)->where('hosting_account_id', $a->id)->whereNull('deleted_at')->update(['deleted_at' => $now]);
        }
        $a->forceFill(['lifecycle_state' => 'purged', 'status' => 'deleting', 'observed_at' => $now])->save();
        $a->delete();
    }
}
