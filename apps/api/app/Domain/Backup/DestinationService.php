<?php

declare(strict_types=1);

namespace App\Domain\Backup;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Domain\Setup\SetupWizard;
use App\Exceptions\ApiProblem;
use App\Models\BackupDestination;
use App\Models\BackupRepository;
use App\Models\Job;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;

/**
 * Đích backup (D-83, ADR 0030): credential ghi mã hóa, kiểm tra kết nối qua job agent (ghim host key SFTP, phát hiện
 * append-only/Object Lock), bộ khôi phục (ADR 0029 §6): lần đầu hiện không cần step-up, sau khi SA xác nhận thì xem lại
 * cần step-up; mọi lần xem đều audit.
 */
final class DestinationService
{
    public function __construct(private readonly JobDispatcher $jobs, private readonly AuditLogger $audit) {}

    /** @param  array<string, mixed>  $in  BackupDestinationInput */
    public function create(User $actor, array $in): BackupDestination
    {
        $type = (string) $in['type'];
        [$config, $creds] = BackupSpec::normalize($type, (array) ($in['config'] ?? []), (array) ($in['credentials'] ?? []), true);
        $this->ensureUnique($type, $config, null);
        $immutable = $in['immutable_days'] ?? null;
        if ($immutable !== null && $type !== 's3') {
            throw ApiProblem::field('immutable_days', 'Object Lock chỉ có ở đích S3.');
        }
        $d = DB::transaction(function () use ($actor, $in, $type, $config, $creds, $immutable): BackupDestination {
            $d = BackupDestination::query()->create(['name' => trim((string) $in['name']), 'type' => $type,
                'server_id' => $type === 'local' ? SetupWizard::localServer()?->id : null, 'config' => $config,
                'credentials_encrypted' => $creds !== [] ? Crypt::encryptString((string) json_encode($creds)) : null,
                'append_only' => (bool) ($in['append_only'] ?? false), 'immutable_days' => $immutable]);
            AgeKeys::panel(); // khóa age của panel sinh cùng đích đầu tiên (đưa vào bộ khôi phục)
            $this->audit->record('backup_destination.create', $d, ['name' => $d->name, 'type' => $type, 'config' => $config], 'success',
                null, null, $actor);

            return $d;
        });

        return $d->refresh();
    }

    /** @param  array<string, mixed>  $in  BackupDestinationInputPatch */
    public function update(User $actor, BackupDestination $d, array $in): BackupDestination
    {
        if (isset($in['type']) && $in['type'] !== $d->type) {
            throw ApiProblem::field('type', 'Không đổi loại đích; tạo đích mới.');
        }
        $changes = [];
        if (array_key_exists('config', $in) || array_key_exists('credentials', $in)) {
            if (array_key_exists('config', $in) && BackupRepository::query()->where('destination_id', $d->id)->whereNotNull('initialized_at')->exists()
                && (array) $in['config'] != $d->config) {
                $moved = array_diff_assoc(array_map('strval', (array) $in['config']), $d->config);
                if (array_intersect(array_keys($moved), ['host', 'path', 'endpoint', 'bucket', 'url']) !== []) {
                    throw ApiProblem::field('config', 'Đích đã có repo: không đổi vị trí lưu (tạo đích mới).');
                }
            }
            $newCreds = array_key_exists('credentials', $in) ? array_filter((array) $in['credentials'], fn ($v) => $v !== '' && $v !== null) : null;
            [$config, $creds] = BackupSpec::normalize($d->type, (array) ($in['config'] ?? $d->config), $newCreds, false);
            $this->ensureUnique($d->type, $config, $d->id);
            if ($config !== $d->config) {
                $changes['config'] = $config;
                $d->config = $config;
                if ($d->type === 'sftp') {
                    $d->host_key_sha256 = null; // host đổi → ghim lại ở lần kiểm tra sau
                }
            }
            if ($creds !== null && $creds !== []) {
                $old = is_string($d->credentials_encrypted) ? (array) json_decode(Crypt::decryptString($d->credentials_encrypted), true) : [];
                $d->credentials_encrypted = Crypt::encryptString((string) json_encode(array_merge($old, array_filter($creds))));
                $changes['credentials'] = array_keys(array_filter($creds));
            }
        }
        if (isset($in['name'])) {
            $d->name = trim((string) $in['name']);
            $changes['name'] = $d->name;
        }
        if (array_key_exists('append_only', $in)) {
            if ($d->append_only && ! $in['append_only'] && BackupRepository::query()->where('destination_id', $d->id)->exists()) {
                throw ApiProblem::field('append_only', 'Không bỏ append-only của đích đã có repo.');
            }
            $d->append_only = (bool) $in['append_only'];
            $changes['append_only'] = $d->append_only;
        }
        if (array_key_exists('immutable_days', $in)) {
            if ($in['immutable_days'] !== null && $d->type !== 's3') {
                throw ApiProblem::field('immutable_days', 'Object Lock chỉ có ở đích S3.');
            }
            $d->immutable_days = $in['immutable_days'] !== null ? (int) $in['immutable_days'] : null;
            $changes['immutable_days'] = $d->immutable_days;
        }
        $d->save();
        $this->audit->record('backup_destination.update', $d, $changes, 'success', null, null, $actor);

        return $d->refresh();
    }

    /** @param  array<string, string>  $config */
    private function ensureUnique(string $type, array $config, ?int $except): void
    {
        foreach (BackupDestination::query()->where('type', $type)->when($except !== null, fn ($q) => $q->whereKeyNot($except))->get() as $o) {
            $same = match ($type) {
                'local' => true,
                'sftp' => ($o->config['host'] ?? '') === $config['host'] && ($o->config['path'] ?? '') === $config['path'],
                's3' => ($o->config['endpoint'] ?? '') === $config['endpoint'] && ($o->config['bucket'] ?? '') === $config['bucket'],
                'rest' => ($o->config['url'] ?? '') === $config['url'],
                default => false,
            };
            if ($same) {
                throw new ApiProblem(409, 'conflict', 'Đích đã tồn tại', "Đã có đích \"{$o->name}\" cùng vị trí lưu.");
            }
        }
    }

    public function test(User $actor, BackupDestination $d): Job
    {
        $server = $d->server_id ?? SetupWizard::localServer()?->id;
        $spec = (new JobSpec('backup.destination_test', null, $server, 1, 120))
            ->step('backup.destination.test', ['destination' => BackupSpec::destination($d)]);

        return DB::transaction(function () use ($actor, $d, $spec): Job {
            $job = $this->jobs->dispatch($spec, $actor);
            $this->audit->record('backup_destination.test', $d, null, 'success', null, $job->id, $actor);

            return $job;
        });
    }

    /**
     * Bộ khôi phục: đích (config không bí mật) + đường dẫn/mật khẩu mọi repo của đích + khóa age của panel.
     *
     * @return array<string, mixed>
     */
    public function recoveryKit(User $actor, BackupDestination $d): array
    {
        $keys = AgeKeys::panel();
        $repos = BackupRepository::query()->where('destination_id', $d->id)->orderByRaw("scope_type = 'server' DESC")->orderBy('id')->get();
        $first = $d->recovery_kit_acknowledged_at === null;
        $this->audit->record('backup_destination.recovery_kit', $d, ['first_view' => $first, 'repositories' => $repos->count()], 'success',
            null, null, $actor);

        return [
            'destination' => ['uuid' => $d->uuid, 'name' => $d->name, 'type' => $d->type, 'config' => $d->config],
            'repositories' => $repos->map(fn (BackupRepository $r): array => ['label' => $r->scope_type === 'server'
                ? 'server '.$r->server->name : 'account '.($r->account->username ?? '?'), 'path' => $r->path,
                'password' => Crypt::decryptString((string) $r->password_encrypted)])->values()->all(),
            'panel_public_key' => $keys['public'],
            'panel_private_key' => $keys['private'],
            'first_view' => $first,
            'generated_at' => Carbon::now()->toIso8601String(),
        ];
    }

    public function acknowledge(User $actor, BackupDestination $d): void
    {
        $d->forceFill(['recovery_kit_acknowledged_at' => Carbon::now(), 'recovery_kit_acknowledged_by_user_id' => $actor->id])->save();
        $this->audit->record('backup_destination.recovery_kit_ack', $d, null, 'success', null, null, $actor);
    }

    /** Repo server mới (bắt buộc cho DR) sau lần xác nhận → bộ khôi phục cũ thiếu mục: đích quay về "chưa xác nhận". */
    public static function kitOutdated(BackupRepository $r): void
    {
        BackupDestination::query()->whereKey($r->destination_id)->whereNotNull('recovery_kit_acknowledged_at')
            ->update(['recovery_kit_acknowledged_at' => null]);
    }
}
