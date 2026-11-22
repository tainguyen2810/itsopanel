<?php

declare(strict_types=1);

namespace App\Domain\WordPress;

use App\Domain\Backup\BackupJobHandler;
use App\Domain\Jobs\JobHandler;
use App\Domain\Notifications\Notifier;
use App\Models\BackupDestination;
use App\Models\BackupRepository;
use App\Models\BackupSnapshot;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\User;
use App\Models\Website;
use App\Models\WordPressSite;
use App\Models\WordPressUpdate;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;

/**
 * Ghi kết quả job WordPress (D-99): wp.info → cache thành phần; wp.detect → site mới; wp.update → lịch sử cập nhật,
 * snapshot pre-wp-update (tính vào quota backup qua backup.stats), thông báo khi khôi phục; cài/staging → DB, website.
 */
final class WordPressJobHandler implements JobHandler
{
    public function __construct(private readonly BackupJobHandler $backups, private readonly Notifier $notifier) {}

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
        WordPressSecrets::forget($job);
        $steps = JobStep::query()->where('job_id', $job->id)->orderBy('seq')->get();
        // backup.repo.init / backup.stats trong job cập nhật: dung lượng repo + quota như job backup.
        if ($steps->contains(fn (JobStep $s): bool => str_starts_with($s->op, 'backup.'))) {
            $ok ? $this->backups->succeeded($job) : $this->backups->failed($job);
        }
        if ($job->type === 'wordpress.scan') {
            $this->scanned($steps);

            return;
        }
        $wp = $job->resource_type === 'wordpress_site' ? WordPressSite::withTrashed()->with(['website', 'account'])->find($job->resource_id) : null;
        if (! $wp instanceof WordPressSite) {
            return;
        }
        foreach ($steps as $st) {
            if ($st->op === 'wp.info' && $st->state === 'succeeded' && is_array($st->result)) {
                WordPressService::storeInfo($wp, $st->result);
            }
        }
        $now = Carbon::now();
        switch ($job->type) {
            case 'wordpress.install':
                $this->settleData($steps);
                $wp->forceFill(['state' => $ok ? 'ok' : 'error', 'last_scan_at' => $ok ? $now : $wp->last_scan_at])->save();
                break;
            case 'wordpress.clone_staging':
                $this->settleData($steps);
                $w = $wp->website;
                $w->forceFill($ok ? ['status' => 'ready', 'observed_version' => $w->spec_version, 'observed_at' => $now, 'drift' => null]
                    : ['status' => 'failed', 'observed_at' => $now, 'drift' => ['apply' => mb_substr((string) ($job->error_message ?? $job->state), 0, 300)]])->save();
                $wp->forceFill(['state' => $ok ? 'ok' : 'error'])->save();
                break;
            case 'wordpress.update':
                $this->updated($job, $wp, $steps, $ok, $now);
                break;
            case 'wordpress.maintenance':
                $st = $steps->firstWhere('op', 'wp.maintenance');
                if ($ok && $st instanceof JobStep) {
                    $wp->forceFill(['maintenance' => (bool) ($st->result['enabled'] ?? false)])->save();
                }
                break;
        }
    }

    /** @param Collection<int, JobStep> $steps */
    private function settleData(Collection $steps): void
    {
        foreach ($steps as $st) {
            $p = $st->params_redacted;
            $done = $st->state === 'succeeded';
            if ($st->op === 'db.mysql.create' && is_string($p['name'] ?? null)) {
                Database::query()->where('name', $p['name'])->where('status', 'provisioning')->update(['status' => $done ? 'ready' : 'failed']);
            }
            if ($st->op === 'db.mysql.user_ensure' && is_string($p['username'] ?? null)) {
                DatabaseUser::query()->where('username', $p['username'])->where('status', 'provisioning')->update(['status' => $done ? 'ready' : 'failed']);
            }
        }
    }

    /** @param Collection<int, JobStep> $steps */
    private function scanned(Collection $steps): void
    {
        foreach ($steps as $st) {
            if ($st->op !== 'wp.detect' || $st->state !== 'succeeded') {
                continue;
            }
            $acc = HostingAccount::query()->where('username', (string) ($st->params_redacted['account']['username'] ?? ''))->first();
            if (! $acc instanceof HostingAccount) {
                continue;
            }
            $sites = Website::query()->where('hosting_account_id', $acc->id)->where('type', 'php')->get()
                ->keyBy(fn (Website $w): string => WordPressService::path($w));
            foreach ((array) ($st->result['sites'] ?? []) as $found) {
                $w = is_array($found) ? $sites->get((string) ($found['path'] ?? '')) : null;
                if (! $w instanceof Website) {
                    continue;
                }
                $wp = WordPressSite::withTrashed()->where('website_id', $w->id)->first() ?? new WordPressSite(['website_id' => $w->id]);
                $wp->forceFill(['hosting_account_id' => $acc->id, 'path' => WordPressService::path($w),
                    'version' => mb_substr((string) ($found['version'] ?? ''), 0, 50), 'multisite' => (bool) ($found['multisite'] ?? false),
                    'last_scan_at' => null, 'deleted_at' => null] + ($wp->exists ? [] : ['state' => 'ok', 'hardening' => []]))->save();
            }
        }
    }

    /** @param Collection<int, JobStep> $steps */
    private function updated(Job $job, WordPressSite $wp, Collection $steps, bool $ok, Carbon $now): void
    {
        $u = WordPressUpdate::query()->where('job_id', $job->id)->first();
        $st = $steps->firstWhere('op', 'wp.update');
        $res = $st instanceof JobStep && $st->state === 'succeeded' && is_array($st->result) ? $st->result : null;
        $rolled = (bool) ($res['rolled_back'] ?? false);
        $state = $res === null ? 'failed' : ($rolled ? 'rolled_back' : 'succeeded');
        if ($res === null && $ok) {
            $state = 'failed';
        }
        $snapId = null;
        if ($res !== null) {
            $repo = BackupRepository::query()->where('uuid', (string) ($st->params_redacted['snapshot']['repo']['repo_uuid'] ?? ''))->first();
            if ($repo instanceof BackupRepository) {
                $file = $this->snapshot($job, $repo, $wp, (string) ($res['snapshot_id'] ?? ''), 'files', $st->finished_at ?? $now);
                $snapId = $file?->id;
                if (is_string($res['db_snapshot_id'] ?? null)) {
                    $this->snapshot($job, $repo, $wp, $res['db_snapshot_id'], 'db', $st->finished_at ?? $now);
                }
            }
        }
        $err = null;
        if ($res === null) {
            $err = mb_substr((string) ($st instanceof JobStep && is_array($st->result['error'] ?? null) ? ($st->result['error']['message'] ?? '')
                : ($job->error_message ?? 'Cập nhật không chạy được.')), 0, 500);
        } elseif ($rolled) {
            $first = collect((array) ($res['results'] ?? []))->first(fn ($r): bool => is_array($r) && ($r['ok'] ?? true) === false);
            $err = is_array($first) && is_string($first['error'] ?? null) ? mb_substr($first['error'], 0, 500)
                : (($res['checksums_ok'] ?? true) === false ? 'Checksum WordPress không khớp sau cập nhật.' : 'Site không trả lời đúng sau cập nhật (HTTP '.(int) ($res['http_status'] ?? 0).').');
        }
        if ($u instanceof WordPressUpdate) {
            $items = $u->items;
            foreach ((array) ($res['results'] ?? []) as $r) {
                foreach ($items as $i => $it) {
                    if (is_array($r) && $it['type'] === ($r['type'] ?? null) && ($it['slug'] ?? null) === ($r['slug'] ?? null)) {
                        $items[$i] = array_merge($it, ['from_version' => (string) ($r['from_version'] ?? $it['from_version']),
                            'to_version' => (string) ($r['to_version'] ?? ''), 'ok' => (bool) ($r['ok'] ?? false)]);
                    }
                }
            }
            $updateFailed = collect((array) ($res['results'] ?? []))->contains(fn ($r): bool => is_array($r) && ($r['ok'] ?? true) === false);
            $verifyOk = ($res['checksums_ok'] ?? false) === true;
            $stepState = fn (string $k): string => match (true) {
                $res === null => $k === 'snapshot' ? 'failed' : 'skipped',
                $k === 'snapshot', $k === 'maintenance' => 'done',
                $k === 'update' => $updateFailed ? 'failed' : 'done',
                $k === 'verify' => $updateFailed ? 'skipped' : ($verifyOk && ! $rolled ? 'done' : 'failed'),
                default => $rolled ? 'done' : 'skipped',
            };
            $u->forceFill(['items' => $items, 'state' => $state, 'snapshot_id' => $snapId, 'error' => $err, 'finished_at' => $now,
                'steps' => array_map(fn (string $k): array => ['key' => $k, 'state' => $stepState($k)], ['snapshot', 'maintenance', 'update', 'verify', 'rollback'])])->save();
        }
        $wp->forceFill(['state' => $state === 'failed' ? 'error' : 'ok', 'last_update_at' => $now])->save();
        if ($state !== 'succeeded') {
            $this->notifyFailure($job, $wp, $state, (string) $err);
        }
    }

    private function snapshot(Job $job, BackupRepository $repo, WordPressSite $wp, string $resticId, string $kind, Carbon $at): ?BackupSnapshot
    {
        if (preg_match('/^[0-9a-f]{8,64}$/', $resticId) !== 1) {
            return null;
        }
        $existing = BackupSnapshot::query()->where('repository_id', $repo->id)->where('restic_snapshot_id', $resticId)->first();
        if ($existing instanceof BackupSnapshot) {
            return $existing;
        }
        $d = BackupDestination::withTrashed()->findOrFail($repo->destination_id);
        $db = $kind === 'db' && $wp->database_id !== null ? Database::withTrashed()->find($wp->database_id) : null;

        return BackupSnapshot::query()->create(['destination_id' => $repo->destination_id, 'repository_id' => $repo->id,
            'restic_snapshot_id' => $resticId, 'scope_type' => $kind === 'db' ? 'database' : 'website',
            'scope_id' => $kind === 'db' ? $db?->id : $wp->website_id, 'hosting_account_id' => $wp->hosting_account_id,
            'website_id' => $wp->website_id, 'databases' => $db instanceof Database ? [$db->name] : [],
            'contents' => [$kind === 'db' ? 'databases' : 'files'],
            'tags' => ['itso', 'type:'.$kind, 'pre-wp-update', 'account:'.$wp->account->uuid], 'size_bytes' => 0,
            'meta' => ['wordpress_site_uuid' => $wp->uuid], 'job_id' => $job->id, 'taken_at' => $at,
            'locked_until' => $d->immutable_days !== null ? $at->copy()->addDays($d->immutable_days) : null]);
    }

    private function notifyFailure(Job $job, WordPressSite $wp, string $state, string $err): void
    {
        $domain = $wp->website->primary_domain ?? '';
        $title = $state === 'rolled_back' ? "Cập nhật WordPress $domain lỗi, đã khôi phục snapshot" : "Cập nhật WordPress $domain thất bại";
        $body = $state === 'rolled_back'
            ? "Site đã về trạng thái trước cập nhật (file + database). Lý do: $err"
            : "Cập nhật không hoàn tất và chưa khôi phục được tự động. Kiểm tra site và snapshot pre-wp-update. Lỗi: $err";
        $users = collect([$wp->account->owner_user_id, $job->requested_by_user_id])->filter()->unique();
        foreach (User::query()->whereIn('id', $users->all())->get() as $u) {
            $this->notifier->notify($u, 'wordpress.update_'.$state, $title, $body, $state === 'rolled_back' ? 'medium' : 'high',
                '/wordpress/'.$wp->uuid);
        }
    }
}
