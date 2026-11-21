<?php

declare(strict_types=1);

namespace App\Domain\Backup;

use App\Domain\Audit\AuditLogger;
use App\Domain\Data\DataSpec;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Domain\Jobs\Secrets;
use App\Domain\Setup\SetupWizard;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\BackupSnapshot;
use App\Models\Database;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\RestoreJob;
use App\Models\Setting;
use App\Models\User;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Khôi phục thảm họa (D-87, Prompt 8.5, docs/runbooks/disaster-recovery.md).
 *
 * 1. Wizard trên máy mới ("itso install --restore"): inspect mở repo server bằng thông tin trong bộ khôi phục (gọi
 *    đồng bộ backup.snapshots, không lưu gì); start chạy job setup.restore (op panel.restore). Bí mật của job nằm tạm
 *    trong Cache (Crypt, TTL 2 giờ), tới agent qua tham chiếu `setup_restore:<uuid>/<khóa>` và bị xóa khi job xong.
 * 2. Agent giải mã backup panel vào staging rồi hẹn `itso panel-restore-apply` (thay DB + /etc/itso, migrate,
 *    itso:reconcile, itso:dr-restore --start).
 * 3. itso:dr-restore (mỗi 5 phút): khôi phục dữ liệu từng account (website + database, ghi đè) song song có giới hạn.
 */
final class DisasterRecovery
{
    public const JOB_TYPE = 'setup.restore';

    public const SECRET_KIND = 'setup_restore';

    public const CACHE_TTL = 7200;

    public const GROUP = 'dr';

    public function __construct(private readonly AgentClient $agent, private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit) {}

    /**
     * Repo server dạng agent-ops từ thông tin người dùng nhập (đích + đường dẫn + mật khẩu); $secret null = giá trị thật
     * (chỉ cho lệnh đồng bộ), có $secret = tham chiếu bí mật vào Cache.
     *
     * @param  array<string, mixed>  $src
     * @return array<string, mixed>
     */
    private function repo(array $src, ?string $secret): array
    {
        $type = (string) $src['type'];
        $c = (array) $src['config'];
        $cr = (array) $src['credentials'];
        $v = fn (string $k, string $plain) => $secret === null ? $plain : Secrets::ref(self::SECRET_KIND, $secret.'/'.$k);
        $dest = match ($type) {
            'local' => ['type' => 'local', 'destination_uuid' => (string) $src['destination_uuid']],
            'sftp' => ['type' => 'sftp', 'destination_uuid' => (string) $src['destination_uuid'], 'host' => $c['host'], 'port' => (int) $c['port'],
                'user' => $c['user'], 'path' => $c['path'], 'host_key_sha256' => null],
            's3' => ['type' => 's3', 'destination_uuid' => (string) $src['destination_uuid'], 'endpoint' => $c['endpoint'], 'bucket' => $c['bucket'],
                'region' => $c['region'] ?? null, 'access_key_id' => $v('access_key', (string) $cr['access_key']),
                'secret_access_key' => $v('secret_key', (string) $cr['secret_key'])],
            'rest' => ['type' => 'rest', 'destination_uuid' => (string) $src['destination_uuid'], 'url' => $c['url'], 'user' => $c['user'],
                'password' => $v('password', (string) $cr['password'])],
            default => throw new \LogicException('loại đích lạ'),
        };

        return ['repo_uuid' => (string) $src['repo_uuid'], 'path' => (string) $src['repository_path'], 'destination' => $dest,
            'password' => $v('repository_password', (string) $src['repository_password'])];
    }

    /**
     * Kiểm + chuẩn hóa SetupRestoreSource (422 theo trường).
     *
     * @param  array<string, mixed>  $in
     * @return array<string, mixed>
     */
    public function source(array $in, string $prefix = ''): array
    {
        $type = $in['type'] ?? null;
        if (! is_string($type) || ! in_array($type, BackupSpec::TYPES, true)) {
            throw ApiProblem::field($prefix.'type', 'Loại đích: local, sftp, s3 hoặc rest.');
        }
        if ($type === 'sftp') {
            // SFTP cần khóa SSH + host key ghim theo destination_uuid của bộ khôi phục: làm bằng CLI trên máy mới.
            throw ApiProblem::field($prefix.'type', 'Đích SFTP: chạy "sudo itso backup panel-restore --kit <file> --snapshot <id> --ssh-key <khóa>" rồi "sudo itso panel-restore-apply --dir <thư mục in ra>" (runbook DR).');
        }
        try {
            [$config, $creds] = BackupSpec::normalize($type, is_array($in['config'] ?? null) ? $in['config'] : [],
                is_array($in['credentials'] ?? null) ? $in['credentials'] : [], true);
        } catch (ApiProblem $e) {
            if ($prefix === '' || $e->errors === null) {
                throw $e;
            }
            $errs = [];
            foreach ($e->errors as $k => $m) {
                $errs[$prefix.$k] = $m;
            }
            throw new ApiProblem(422, 'validation_failed', $e->title, $e->detail, $errs);
        }
        $path = $in['repository_path'] ?? null;
        if (! is_string($path) || preg_match('#^itso/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/server$#', $path) !== 1) {
            throw ApiProblem::field($prefix.'repository_path', 'Đường dẫn repo server dạng itso/<uuid server>/server (dòng "repo:" của mục "server <tên máy>" trong bộ khôi phục).');
        }
        $pw = $in['repository_password'] ?? null;
        if (! is_string($pw) || preg_match('/^[\x21-\x7e]{16,256}$/', $pw) !== 1) {
            throw ApiProblem::field($prefix.'repository_password', 'Mật khẩu repo 16–256 ký tự in được.');
        }
        $key = $in['panel_private_key'] ?? null;
        if (! is_string($key) || preg_match('/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/', trim($key)) !== 1) {
            throw ApiProblem::field($prefix.'panel_private_key', 'Khóa riêng age dạng AGE-SECRET-KEY-1… (trong bộ khôi phục).');
        }

        return ['type' => $type, 'config' => $config, 'credentials' => $creds ?? [], 'repository_path' => $path,
            'repository_password' => $pw, 'panel_private_key' => trim($key),
            'repo_uuid' => (string) Str::uuid7(), 'destination_uuid' => (string) Str::uuid7()];
    }

    /**
     * Liệt kê bản backup panel (tag type:panel) trong repo server, mới nhất trước. Không lưu credential/mật khẩu/khóa.
     *
     * @param  array<string, mixed>  $src  kết quả source()
     * @return list<array<string, mixed>>
     */
    public function inspect(array $src): array
    {
        try {
            $res = $this->agent->call('backup.snapshots', ['repo' => $this->repo($src, null), 'tags' => ['type:panel'], 'limit' => 50],
                (string) Str::uuid7().':1:1', ['user_uuid' => null, 'role' => 'SYSTEM'], 120.0);
        } catch (AgentUnavailable $e) {
            throw new ApiProblem(503, 'agent_unavailable', 'Agent không kết nối được', mb_substr($e->getMessage(), 0, 200));
        }
        if (! $res->ok) {
            $code = (string) ($res->error['code'] ?? 'internal');
            $msg = mb_substr((string) ($res->error['message'] ?? ''), 0, 300);
            // Sai mật khẩu/không mở được repo → 422 trên trường tương ứng; lỗi khác → 409.
            if (in_array($code, ['repo_wrong_password', 'invalid_params'], true)) {
                throw ApiProblem::field('repository_password', 'Không mở được repo: '.$msg);
            }
            if (in_array($code, ['repo_not_found', 'not_found', 'destination_unreachable'], true)) {
                throw ApiProblem::field('repository_path', 'Không tìm thấy repo: '.$msg);
            }
            throw new ApiProblem(409, $code, 'Agent từ chối', $msg);
        }
        $out = [];
        foreach ((array) ($res->data['snapshots'] ?? []) as $s) {
            if (! is_array($s) || ! is_string($s['id'] ?? null) || preg_match('/^[0-9a-f]{8,64}$/', $s['id']) !== 1) {
                continue;
            }
            $size = is_int($s['size_bytes'] ?? null) ? $s['size_bytes'] : 0;
            $out[] = ['snapshot_id' => $s['id'], 'taken_at' => Carbon::parse((string) $s['time'])->toIso8601String(),
                // Phiên bản + số account nằm trong bản backup đã mã hóa age: chỉ biết sau khi giải mã.
                'panel_version' => 'unknown', 'hostname' => mb_substr((string) ($s['hostname'] ?? ''), 0, 253),
                'accounts' => null, 'size_mb' => round($size / 1048576, 1)];
        }
        usort($out, fn ($a, $b) => strcmp($b['taken_at'], $a['taken_at']));

        return $out;
    }

    /** @param  array<string, mixed>  $src  kết quả source() */
    public function start(array $src, string $snapshotId): Job
    {
        $server = SetupWizard::localServer();
        if ($server === null) {
            throw new ApiProblem(409, 'precondition_failed', 'Chưa có server', 'Agent trên máy cài panel chưa đăng ký server.');
        }
        if (Job::query()->where('type', self::JOB_TYPE)->whereIn('state', ['queued', 'running', 'cancel_requested'])->exists()) {
            throw ApiProblem::conflict('Đang có một lần khôi phục panel chạy; chờ job đó xong.');
        }
        $id = (string) Str::uuid7();
        Cache::put(self::cacheKey($id), Crypt::encryptString((string) json_encode([
            'access_key' => $src['credentials']['access_key'] ?? null, 'secret_key' => $src['credentials']['secret_key'] ?? null,
            'password' => $src['credentials']['password'] ?? null, 'repository_password' => $src['repository_password'],
            'age_identity' => $src['panel_private_key'],
        ])), self::CACHE_TTL);
        $spec = (new JobSpec(self::JOB_TYPE, $server, $server->id, 1, 3600))
            ->step('panel.restore', ['repo' => $this->repo($src, $id), 'snapshot_id' => $snapshotId,
                'age_identity' => Secrets::ref(self::SECRET_KIND, $id.'/age_identity'), 'apply_delay_sec' => 10]);
        $job = $this->jobs->dispatch($spec, null);
        $this->audit->record('setup.restore_started', $server, ['snapshot_id' => $snapshotId, 'type' => $src['type'],
            'repository_path' => $src['repository_path']], 'success', $server->id, $job->id, null);

        return $job;
    }

    public static function cacheKey(string $id): string
    {
        return 'itso:setup-restore:'.$id;
    }

    /** Giải tham chiếu `setup_restore:<uuid>/<khóa>` (Secrets). */
    public static function secret(string $ref): ?string
    {
        if (preg_match('#^([0-9a-f-]{36})/([a-z_]{1,40})$#', $ref, $m) !== 1) {
            return null;
        }
        $enc = Cache::get(self::cacheKey($m[1]));
        if (! is_string($enc)) {
            return null;
        }
        $d = json_decode(Crypt::decryptString($enc), true);

        return is_array($d) && is_string($d[$m[2]] ?? null) ? $d[$m[2]] : null;
    }

    /** Job setup.restore xong (thành công hay không): xóa bí mật tạm. */
    public static function forget(Job $job): void
    {
        foreach (DB::table('job_steps')->where('job_id', $job->id)->pluck('params_redacted') as $raw) {
            $p = is_string($raw) ? json_decode($raw, true) : (array) $raw;
            $ref = is_array($p) ? ($p['age_identity'][Secrets::KEY] ?? null) : null;
            if (is_string($ref) && preg_match('#^'.self::SECRET_KIND.':([0-9a-f-]{36})/#', $ref, $m) === 1) {
                Cache::forget(self::cacheKey($m[1]));
            }
        }
    }

    // ------------------------------------------------------------------ khôi phục dữ liệu account (itso:dr-restore)

    public function setting(string $key): mixed
    {
        return Setting::query()->where('group_key', self::GROUP)->where('key', $key)->first()?->value['v'] ?? null;
    }

    private function put(string $key, mixed $v): void
    {
        Setting::query()->updateOrCreate(['group_key' => self::GROUP, 'key' => $key], ['value' => ['v' => $v]]);
    }

    /** Bật khôi phục dữ liệu account (gọi bởi itso panel-restore-apply sau khi thay DB panel). */
    public function begin(): void
    {
        if ($this->setting('started_at') === null) {
            $this->put('started_at', Carbon::now()->toIso8601String());
            $this->put('finished_at', null);
            $this->put('accounts', (object) []);
            $this->audit->record('dr.started', null, null, 'success', null, null, null);
        }
    }

    /**
     * Một lượt: xếp hàng tối đa $parallel job khôi phục đang chạy; trả các dòng mô tả.
     *
     * @return list<string>
     */
    public function tick(int $parallel, bool $dryRun): array
    {
        if ($this->setting('started_at') === null) {
            return ['Chưa bật khôi phục thảm họa (itso:dr-restore --start).'];
        }
        if ($this->setting('finished_at') !== null) {
            return ['Khôi phục dữ liệu account đã xong lúc '.$this->setting('finished_at').'.'];
        }
        /** @var array<string, string|null> $map account uuid → restore uuid (null: không có gì để khôi phục) */
        $map = (array) ($this->setting('accounts') ?? []);
        $running = RestoreJob::query()->whereIn('uuid', array_values(array_filter($map)))->whereIn('status', ['queued', 'running'])->count();
        $lines = [];
        $todo = HostingAccount::query()->whereIn('lifecycle_state', ['active', 'suspended'])->orderBy('id')->get()
            ->filter(fn (HostingAccount $a) => ! array_key_exists($a->uuid, $map));
        $actor = User::query()->where('realm', 'admin')->where('status', 'active')
            ->whereHas('roles', fn ($q) => $q->where('key', 'SUPER_ADMIN'))->orderBy('id')->first();
        foreach ($todo as $a) {
            if ($running >= $parallel) {
                break;
            }
            // Chờ job đồng bộ (itso:reconcile) của account xong: home/website/DB phải có trước khi chép dữ liệu.
            if (Job::query()->where('resource_type', 'hosting_account')->where('resource_id', $a->id)
                ->whereIn('state', ['queued', 'running', 'cancel_requested'])->exists()) {
                $lines[] = "{$a->username}: chờ job đồng bộ";

                continue;
            }
            $plan = $this->plan($a);
            if ($plan['items'] === []) {
                $lines[] = "{$a->username}: không có snapshot để khôi phục";
                if (! $dryRun) {
                    $map[$a->uuid] = null;
                }

                continue;
            }
            $lines[] = "{$a->username}: ".implode(', ', array_column($plan['items'], 'label'));
            if ($dryRun || ! $actor instanceof User) {
                continue;
            }
            $map[$a->uuid] = $this->dispatch($a, $plan, $actor)->uuid;
            $running++;
        }
        if (! $dryRun) {
            $this->put('accounts', (object) $map);
            $left = HostingAccount::query()->whereIn('lifecycle_state', ['active', 'suspended'])->pluck('uuid')
                ->filter(fn ($u) => ! array_key_exists((string) $u, $map))->count();
            if ($left === 0 && $running === 0
                && ! RestoreJob::query()->whereIn('uuid', array_values(array_filter($map)))->whereIn('status', ['queued', 'running'])->exists()) {
                $this->put('finished_at', Carbon::now()->toIso8601String());
                $failed = RestoreJob::query()->whereIn('uuid', array_values(array_filter($map)))->where('status', 'failed')->count();
                $this->audit->record('dr.finished', null, ['accounts' => count($map), 'failed' => $failed], $failed > 0 ? 'failure' : 'success',
                    null, null, null);
                $lines[] = 'Khôi phục dữ liệu account xong'.($failed > 0 ? " ($failed account lỗi: xem Backup → Khôi phục)" : '').'.';
            }
        }
        if ($actor === null) {
            $lines[] = 'Chưa có SUPER_ADMIN hoạt động để đứng tên job khôi phục.';
        }

        return $lines;
    }

    /**
     * Snapshot mới nhất: files của account (mọi website) + từng database.
     *
     * @return array{files: BackupSnapshot|null, items: list<array{label: string, snapshot: BackupSnapshot, item: array<string, mixed>, raw: string}>}
     */
    private function plan(HostingAccount $a): array
    {
        $files = BackupSnapshot::query()->where('hosting_account_id', $a->id)->where('scope_type', 'hosting_account')
            ->orderByDesc('taken_at')->first();
        $items = [];
        if ($files instanceof BackupSnapshot) {
            foreach (Website::query()->where('hosting_account_id', $a->id)->orderBy('id')->pluck('primary_domain') as $d) {
                $items[] = ['label' => "sites/$d", 'snapshot' => $files, 'item' => ['kind' => 'website', 'site_dir' => (string) $d], 'raw' => "files:sites/$d"];
            }
        }
        $dbSnaps = BackupSnapshot::query()->where('hosting_account_id', $a->id)->where('scope_type', 'database')->orderByDesc('taken_at')->get();
        foreach (Database::query()->where('hosting_account_id', $a->id)->orderBy('id')->get() as $db) {
            $s = $dbSnaps->first(fn (BackupSnapshot $s) => in_array($db->name, (array) $s->databases, true));
            if ($s instanceof BackupSnapshot) {
                $engine = $db->engine === 'postgresql' ? 'postgresql' : 'mariadb';
                $items[] = ['label' => "database:{$db->name}", 'snapshot' => $s, 'raw' => "database:{$db->name}",
                    'item' => ['kind' => 'database', 'db' => ['engine' => $engine, 'name' => $db->name], 'target_name' => $db->name]];
            }
        }

        return ['files' => $files, 'items' => $items];
    }

    /** @param  array{files: BackupSnapshot|null, items: list<array{label: string, snapshot: BackupSnapshot, item: array<string, mixed>, raw: string}>}  $plan */
    private function dispatch(HostingAccount $a, array $plan, User $actor): RestoreJob
    {
        return DB::transaction(function () use ($a, $plan, $actor): RestoreJob {
            $first = $plan['files'] ?? $plan['items'][0]['snapshot'];
            $rj = RestoreJob::query()->create(['snapshot_id' => $first->id, 'hosting_account_id' => $a->id, 'target_type' => 'hosting_account',
                'target_id' => $a->id, 'target_server_id' => $a->server_id, 'mode' => 'overwrite', 'items' => array_column($plan['items'], 'raw'),
                'status' => 'queued', 'requested_by_user_id' => $actor->id]);
            // Agent: ghi đè mỗi bước đúng một website/database (đích chưa có → tạo mới).
            $spec = new JobSpec('backup.restore', $a, $a->server_id, 1, 6 * 3600);
            foreach ($plan['items'] as $it) {
                $spec->step('backup.restore', ['repo' => BackupSpec::repo($it['snapshot']->repository), 'snapshot_id' => $it['snapshot']->restic_snapshot_id,
                    'restore_uuid' => $rj->uuid, 'account' => DataSpec::acct($a), 'mode' => 'overwrite', 'items' => [$it['item']],
                    'pre_restore_tags' => ['account:'.$a->uuid]]);
            }
            $job = $this->jobs->dispatch($spec, $actor);
            $rj->forceFill(['job_id' => $job->id])->save();
            $this->audit->record('dr.account_restore', $a, ['items' => array_column($plan['items'], 'raw')], 'success', $a->server_id, $job->id, null);

            return $rj->refresh();
        });
    }
}
