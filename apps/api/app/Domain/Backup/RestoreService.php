<?php

declare(strict_types=1);

namespace App\Domain\Backup;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Audit\AuditLogger;
use App\Domain\Data\DataSpec;
use App\Domain\Hosting\ProvisioningService;
use App\Domain\Hosting\QuotaService;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\ServerPresenter;
use App\Models\Agent;
use App\Models\BackupSnapshot;
use App\Models\ComposeProject;
use App\Models\Database;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\RestoreJob;
use App\Models\Server;
use App\Models\User;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Khôi phục (D-85, ADR 0032): agent giải vào staging root rồi helper uid account chép vào home. Item "files:sites/<domain>"
 * của website đang có → khôi phục website (ghi đè = snapshot pre-restore + đổi chỗ nguyên tử); "files:<đường dẫn>" khác →
 * "backups/restore-<ts>/"; "database:<tên>" → DB mới "<tên>_r<ts>" hoặc ghi đè (dump pre-restore trước).
 * Ghi đè: một item, step-up (route) và "confirm" = username account.
 */
final class RestoreService
{
    public function __construct(private readonly JobDispatcher $jobs, private readonly AuditLogger $audit,
        private readonly QuotaService $quota, private readonly BackupService $backups, private readonly Access $access) {}

    /** @param  list<string>  $items */
    public function create(User $actor, BackupSnapshot $s, string $mode, array $items, ?string $confirm, ?Server $target): RestoreJob
    {
        if ($s->scope_type === 'compose_project') {
            return $this->volume($actor, $s, $mode, $items, $confirm, $target);
        }
        $a = $s->hosting_account_id !== null ? HostingAccount::query()->find($s->hosting_account_id) : null;
        if (! $a instanceof HostingAccount) {
            throw ApiProblem::field('snapshot_uuid', 'Snapshot cấu hình máy chủ/panel không khôi phục qua đây: dùng "itso backup panel-restore" (DR).');
        }
        $cross = $target !== null && $target->id !== $a->server_id;
        if ($cross) {
            // ADR 0038 §3: khôi phục sang server khác = bản sao để kiểm tra/xuất (account.ensure + restore ở đích),
            // chỉ Admin, chỉ bản mới; account vẫn thuộc server cũ (chuyển hẳn: dùng chuyển account).
            if ($actor->realm !== Realm::ADMIN || ! $this->access->servers($actor)->whereKey($target->id)->exists()) {
                throw ApiProblem::field('target_server_uuid', 'Không có quyền khôi phục sang máy chủ này.');
            }
            if ($mode !== 'new') {
                throw ApiProblem::field('mode', 'Khôi phục sang máy chủ khác chỉ ra bản mới (mode=new).');
            }
            $ag = Agent::query()->where('server_id', $target->id)->first();
            if (! $ag instanceof Agent || ServerPresenter::connection($ag) !== 'online') {
                throw new ApiProblem(409, 'agent_unreachable', 'Máy chủ đích không kết nối', "{$target->name} đang mất kết nối agent.");
            }
        }
        if ($a->lifecycle_state !== 'active') {
            throw new ApiProblem(409, 'invalid_state_transition', 'Account không hoạt động', "Account đang {$a->lifecycle_state}: kích hoạt lại trước khi khôi phục.");
        }
        if ($items === [] || count($items) > 50) {
            throw ApiProblem::field('items', 'Cần 1–50 mục.');
        }
        if ($mode === 'overwrite') {
            if (count($items) !== 1) {
                throw ApiProblem::field('items', 'Ghi đè: mỗi lần đúng một website hoặc một database.');
            }
            if ($confirm !== $a->username) {
                throw ApiProblem::field('confirm', 'Gõ đúng username account để xác nhận ghi đè.');
            }
        }
        $this->backups->ensureIdle($a);
        $ts = Carbon::now()->format('mdHi');
        $agentItems = [];
        $newDbs = [];
        foreach ($items as $i => $raw) {
            if ($raw === 'config') {
                throw ApiProblem::field("items.$i", 'Khôi phục cấu hình máy chủ: dùng DR ("itso backup panel-restore").');
            }
            [$kind, $val] = explode(':', $raw, 2) + [1 => ''];
            if ($kind === 'files') {
                $path = DataSpec::relPath($val, "items.$i", false);
                $siteDir = preg_match('#^sites/([a-z0-9.-]+)$#', $path, $m) === 1 ? $m[1] : null;
                $site = $siteDir !== null ? Website::query()->where('hosting_account_id', $a->id)->where('primary_domain', $siteDir)->first() : null;
                if ($siteDir !== null && ($site instanceof Website || $mode === 'overwrite')) {
                    $agentItems[] = ['kind' => 'website', 'site_dir' => $siteDir];
                } elseif ($mode === 'overwrite') {
                    throw ApiProblem::field("items.$i", 'File lẻ luôn khôi phục vào backups/restore-<ts>/ (chế độ new).');
                } else {
                    $agentItems[] = ['kind' => 'files', 'path' => $path];
                }
            } elseif ($kind === 'database') {
                if (! in_array($val, $s->databases, true)) {
                    throw ApiProblem::field("items.$i", "Snapshot không có database $val.");
                }
                $engine = Database::withTrashed()->where('hosting_account_id', $a->id)->where('name', $val)->value('engine');
                $engine = $engine === 'postgresql' ? 'postgresql' : 'mariadb';
                $targetName = $mode === 'overwrite' ? $val : mb_substr($val, 0, $engine === 'postgresql' ? 57 : 58).'_r'.$ts;
                if ($mode === 'new' && $cross) {
                    $newDbs[] = [$engine, $targetName, true];
                } elseif ($mode === 'new') {
                    if (Database::query()->where('server_id', $a->server_id)->where('engine', $engine)->where('name', $targetName)->exists()) {
                        throw new ApiProblem(409, 'conflict', 'Database đích đã có', "Đã có database $targetName: thử lại sau một phút.");
                    }
                    $newDbs[] = [$engine, $targetName];
                } elseif (! Database::query()->where('hosting_account_id', $a->id)->where('name', $val)->exists()) {
                    throw ApiProblem::field("items.$i", "Database $val không còn: khôi phục ở chế độ new.");
                }
                $agentItems[] = ['kind' => 'database', 'db' => ['engine' => $engine, 'name' => $val], 'target_name' => $targetName];
            } else {
                throw ApiProblem::field("items.$i", 'Mục phải là files:<đường dẫn>, database:<tên> hoặc config.');
            }
        }

        $serverId = $cross ? $target->id : $a->server_id;

        return DB::transaction(function () use ($actor, $s, $a, $mode, $items, $agentItems, $newDbs, $cross, $serverId): RestoreJob {
            /** @var HostingAccount $acc */
            $acc = HostingAccount::query()->lockForUpdate()->findOrFail($a->id);
            foreach ($newDbs as $nd) {
                [$engine, $name] = $nd;
                if ($cross) {
                    continue; // bản sao ở server khác: không thành DB được quản lý của account
                }
                $this->quota->ensureCanAdd($acc, 'databases');
                Database::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $acc->server_id, 'engine' => $engine, 'name' => $name,
                    'charset' => $engine === 'postgresql' ? 'UTF8' : 'utf8mb4', 'status' => 'provisioning', 'size_mb' => 0]);
            }
            $rj = RestoreJob::query()->create(['snapshot_id' => $s->id, 'hosting_account_id' => $acc->id, 'target_type' => 'hosting_account',
                'target_id' => $acc->id, 'target_server_id' => $serverId, 'mode' => $mode, 'items' => $items, 'status' => 'queued',
                'requested_by_user_id' => $actor->id]);
            $spec = new JobSpec('backup.restore', $acc, $serverId, 1, 4 * 3600);
            if ($cross) {
                $limits = $this->quota->limits($acc);
                $spec->step('account.ensure', ['account' => ProvisioningService::ref($acc), 'home_path' => $acc->home_path,
                    'shell' => '/usr/sbin/nologin', 'limits' => ProvisioningService::agentLimits($limits)]);
                foreach ($newDbs as [$engine, $name]) {
                    $spec->step(DataSpec::op($engine, 'owner_ensure'), ['account' => DataSpec::acct($acc)])
                        ->step(DataSpec::op($engine, 'create'), ['account' => DataSpec::acct($acc), 'name' => $name,
                            'charset' => $engine === 'postgresql' ? 'UTF8' : 'utf8mb4']);
                }
            }
            $spec->step('backup.restore', ['repo' => BackupSpec::repo($s->repository), 'snapshot_id' => $s->restic_snapshot_id, 'restore_uuid' => $rj->uuid,
                'account' => DataSpec::acct($acc), 'mode' => $mode, 'items' => $agentItems, 'pre_restore_tags' => ['account:'.$acc->uuid]]);
            $job = $this->jobs->dispatch($spec, $actor);
            $rj->forceFill(['job_id' => $job->id])->save();
            $this->audit->record('backup.restore', $acc, ['snapshot' => $s->uuid, 'mode' => $mode, 'items' => $items,
                'target_server' => $cross ? Server::query()->find($serverId)?->name : null], 'success', $serverId, $job->id, $actor);

            return $rj->refresh();
        });
    }

    /**
     * Khôi phục volume Docker (D-98): chỉ Admin; mỗi lần một `volume:<tên>` có trong snapshot; new → volume mới
     * `<tên>_r<ts>`, overwrite → ghi đè volume (gõ đúng tên project để xác nhận; agent từ chối nếu volume đang dùng).
     *
     * @param  list<string>  $items
     */
    private function volume(User $actor, BackupSnapshot $s, string $mode, array $items, ?string $confirm, ?Server $target): RestoreJob
    {
        $p = ComposeProject::withTrashed()->find($s->scope_id);
        if ($actor->realm !== Realm::ADMIN || ! $p instanceof ComposeProject || ! $this->access->servers($actor)->whereKey($p->server_id)->exists()) {
            throw ApiProblem::field('snapshot_uuid', 'Không có quyền khôi phục snapshot Docker này.');
        }
        if ($target !== null && $target->id !== $p->server_id) {
            throw ApiProblem::field('target_server_uuid', 'Volume Docker chỉ khôi phục trên máy chủ gốc.');
        }
        $vols = array_values(array_map('strval', (array) ($s->meta['volumes'] ?? [])));
        if (count($items) !== 1 || preg_match('/^volume:([a-z0-9][a-z0-9_.-]{0,127})$/', $items[0], $m) !== 1 || ! in_array($m[1], $vols, true)) {
            throw ApiProblem::field('items', 'Chọn đúng một volume:<tên> có trong snapshot ('.implode(', ', $vols).').');
        }
        $vol = $m[1];
        if ($mode === 'overwrite' && $confirm !== $p->name) {
            throw ApiProblem::field('confirm', 'Gõ đúng tên compose project để xác nhận ghi đè volume.');
        }
        $targetVol = $mode === 'overwrite' ? $vol : substr($vol, 0, 110).'_r'.Carbon::now()->format('mdHi');

        return DB::transaction(function () use ($actor, $s, $p, $mode, $items, $vol, $targetVol): RestoreJob {
            $rj = RestoreJob::query()->create(['snapshot_id' => $s->id, 'hosting_account_id' => null, 'target_type' => 'compose_project',
                'target_id' => $p->id, 'target_server_id' => $p->server_id, 'mode' => $mode, 'items' => $items, 'status' => 'queued',
                'requested_by_user_id' => $actor->id]);
            $job = $this->jobs->dispatch((new JobSpec('backup.restore', $p, $p->server_id, 1, 4 * 3600))
                ->step('docker.volume.restore', ['repo' => BackupSpec::repo($s->repository), 'snapshot_id' => $s->restic_snapshot_id,
                    'volume' => $vol, 'mode' => $mode, 'target' => $targetVol]), $actor);
            $rj->forceFill(['job_id' => $job->id])->save();
            $this->audit->record('backup.restore_volume', $p, ['snapshot' => $s->uuid, 'mode' => $mode, 'volume' => $vol, 'target' => $targetVol],
                'success', $p->server_id, $job->id, $actor);

            return $rj->refresh();
        });
    }

    public static function job(RestoreJob $r): ?Job
    {
        return $r->job_id !== null ? Job::query()->find($r->job_id) : null;
    }
}
